// The gate's three verbs: status (what needs checking), save (write the report) and
// verify (does a commit match its report). The hooks and CI all call verify.

import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { dict, get, isFile, isRecord, isSymlink, own, today } from "../util.js";
import {
  changedLinesText,
  collectChanges,
  fileStates,
  needsVerification,
  SAME,
  type State,
  smallChange,
} from "./changes.js";
import { isSensitive, loadConfig, needsNoQuestions, rulesFromBase, rulesFromBaseOrWorktree } from "./config.js";
import { atomicWrite, readRepoFile } from "./files.js";
import { currentBranch, readFileAtRev, repoRoot, resolveBase, revHasFile } from "./git.js";
import { matches } from "./glob.js";
import { previousReport, readReport, renderReport, reportPath } from "./report.js";
import { GATE_REL, GATE_VERSION, GateError, REPORT_INPUT, sorted, VERSION_RE } from "./shared.js";

// English only: terminals draw Arabic letters in reverse order. The skill still understands "اختبرني".
const CHECK_ME_HINT = 'Ask Claude to run the ownership check ("check me"), then commit the report.';

/** A summary is measured after trimming blank characters from both ends:
 *  Unicode spaces and line breaks, plus the ASCII separator controls
 *  (U+001C–U+001F) and NEL (U+0085), so invisible padding can't stretch a
 *  summary to the minimum. Its length is counted in characters (code points):
 *  an emoji is one character, not two. */
const BLANK = "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";

const BLANK_ENDS = new RegExp(`^${BLANK}+|${BLANK}+$`, "gu");

const trimSummary = (s: string) => s.replace(BLANK_ENDS, "");

const charCount = (s: string) => [...s].length;

export function status(repo?: string | null, base?: string | null, branch?: string | null) {
  const root = repoRoot(repo);
  const baseRef = resolveBase(root, loadConfig(root), base);
  const cfg = rulesFromBaseOrWorktree(root, baseRef);
  const br = currentBranch(root, branch);
  const [changes, untracked, mb] = collectChanges(root, baseRef, null);
  const [report, note] = previousReport(root, br, baseRef);
  const st = fileStates(root, changes, report, "HEAD", mb);
  const oldVerified = report ? report.verified : dict<string[]>();
  const files = Object.entries(changes).map(([p, c]) => ({
    path: p,
    state: st[p],
    sensitive: isSensitive(p, c.mode, cfg),
    ignored: matches(p, cfg.ignore),
    untracked: untracked.has(p),
    verified: Boolean(get(oldVerified, p)?.length) && SAME.includes(st[p]),
  }));
  const notes = note ? [note] : [];
  if (Object.values(st).includes("rebased")) {
    notes.push(
      "Some verified files were rebased: save the report again (no new questions needed), or CI won't be able to match them.",
    );
  }
  const localGate = join(root, GATE_REL);
  if (isFile(localGate) && !isSymlink(localGate)) {
    let head = "";
    try {
      head = readRepoFile(localGate, 8 * 1024 * 1024).slice(0, 4096);
    } catch {
      /* unreadable: no note */
    }
    const v = VERSION_RE.exec(head);
    if (v && Number(v[1]) !== GATE_VERSION) {
      notes.push(
        `This repo's ${GATE_REL} is v${v[1]} but the running gate is v${GATE_VERSION}. CI runs the base branch's copy, so update whichever is older (the plugin, or \`gate.mjs install --upgrade\` in a PR).`,
      );
    }
  }
  if (existsSync(localGate) && revHasFile(root, baseRef, GATE_REL)) {
    let head = "";
    try {
      head = readFileAtRev(root, baseRef, GATE_REL, 8 * 1024 * 1024).slice(0, 4096);
    } catch {
      /* unreadable: no note */
    }
    const v = VERSION_RE.exec(head);
    if (v && Number(v[1]) !== GATE_VERSION) {
      notes.push(
        `The base branch runs gate v${v[1]} but this one is v${GATE_VERSION}: merge the base branch first, or CI will reject the report.`,
      );
    }
  }
  const small = smallChange(root, baseRef, mb, null, changes, cfg);
  if (small.note) notes.push(small.note);
  return {
    mode: cfg.mode,
    configured: cfg._configured,
    base: baseRef,
    branch: br,
    report: reportPath(br),
    report_exists: report !== null,
    files,
    must_verify: needsVerification(changes, st, report, cfg),
    small_change: small.small,
    changed_lines: small.lines,
    min_summary_chars: small.small ? cfg.small_summary_chars : cfg.min_summary_chars,
    notes,
  };
}

type Status = ReturnType<typeof status>;

export function formatStatus(s: Status): string {
  const mode = s.mode + (s.configured ? "" : ", no .learning/config.json");
  const lines = [`Ownership check — branch ${s.branch} vs ${s.base} (mode: ${mode})`];
  if (!s.files.length) return [lines[0], "No changes — nothing to check.", ...s.notes].join("\n");
  lines.push(`Report: ${s.report} (${s.report_exists ? "exists" : "not yet saved"})`);
  for (const f of s.files) {
    const tags = [
      f.state,
      ...(["sensitive", "ignored", "untracked", "verified"] as const)
        .filter((t) => f[t])
        .map((t) => (t === "sensitive" ? "SENSITIVE" : t)),
    ];
    lines.push(`- ${f.path} [${tags.join(", ")}]`);
  }
  if (s.must_verify.length) lines.push(`Must be verified before saving: ${s.must_verify.join(", ")}`);
  if (s.small_change) {
    lines.push(
      `Small change (${changedLinesText(s.changed_lines ?? 0)}): one question is enough, and the summary needs at least ${s.min_summary_chars} characters.`,
    );
  }
  lines.push(...s.notes);
  return lines.join("\n");
}

export function save(
  payload: Record<string, unknown>,
  repo?: string | null,
  base?: string | null,
  branch?: string | null,
): string {
  const root = repoRoot(repo);
  const baseRef = resolveBase(root, loadConfig(root), base);
  const cfg = rulesFromBaseOrWorktree(root, baseRef);
  const br = currentBranch(root, branch);
  const [changes, untracked, mb] = collectChanges(root, baseRef, null);
  if (!Object.keys(changes).length) throw new GateError(`No changes vs ${baseRef} — nothing to report.`);

  const summary = trimSummary(String(payload.summary ?? ""));
  const len = charCount(summary);
  // Only count lines when it can matter: a long enough summary passes either way.
  const minChars =
    len < cfg.min_summary_chars && smallChange(root, baseRef, mb, null, changes, cfg).small
      ? cfg.small_summary_chars
      : cfg.min_summary_chars;
  if (len < minChars) {
    throw new GateError(
      `The summary must be the developer's own description of what changed, why, and what could break — at least ${minChars} characters.`,
    );
  }
  const rawVerified = payload.verified ?? {};
  if (!isRecord(rawVerified)) throw new GateError('"verified" must map file paths to lists of concepts.');
  const verified: Record<string, string[]> = dict();
  for (const [path, concepts0] of Object.entries(rawVerified)) {
    const concepts = typeof concepts0 === "string" ? [concepts0] : Array.isArray(concepts0) ? concepts0 : [];
    const items = concepts.map((c) => String(c).trim()).filter(Boolean);
    if (items.length) verified[String(path).trim().replace(/^\.\//, "")] = items;
  }
  const unknown = sorted(Object.keys(verified).filter((p) => !own(changes, p)));
  if (unknown.length)
    throw new GateError(
      `Not part of this change: ${unknown.join(", ")}. Changed files: ${Object.keys(changes).join(", ")}`,
    );

  const [old] = previousReport(root, br, baseRef);
  const st = fileStates(root, changes, old, "HEAD", mb);
  const missing = needsVerification(changes, st, old, cfg).filter((p) => !own(verified, p));
  if (missing.length)
    throw new GateError(
      `Still needs verification (sensitive, or new/changed since the last report): ${missing.join(", ")}`,
    );
  if (old) {
    // keep earlier verification for files whose verified change is intact
    for (const [p, concepts] of Object.entries(old.verified)) {
      if (own(changes, p) && SAME.includes(st[p]) && !own(verified, p)) verified[p] = concepts;
    }
  }
  const askable = Object.entries(changes).filter(([p, c]) => !needsNoQuestions(p, c.mode, cfg));
  if (askable.length && !Object.keys(verified).length)
    throw new GateError("No verified files — the check needs at least one area the developer explained.");

  const data = { version: GATE_VERSION, branch: br, base: baseRef, date: today(), summary, verified, files: changes };
  const rel = reportPath(br);
  atomicWrite(join(root, rel), renderReport(data));
  const extra = sorted([...untracked].filter((p) => own(changes, p)));
  const note = extra.length
    ? ` Untracked files included: ${extra.join(", ")} — commit them too, or they'll show as changed.`
    : "";
  const n = Object.keys(changes).length;
  return `Saved ${rel}: ${n} file${n === 1 ? "" : "s"} fingerprinted, ${Object.keys(verified).length} verified. Commit it together with the code.${note}`;
}

export function verify(
  repo?: string | null,
  base?: string | null,
  branch?: string | null,
  rev = "HEAD",
  labels: string[] = [],
): [boolean, string[], string] {
  const root = repoRoot(repo);
  const baseRef = resolveBase(root, loadConfig(root, rev), base);
  const cfg = rulesFromBase(root, baseRef);
  if (cfg.mode === "off") return [true, [], "off"];
  if (labels.includes(cfg.skip_label)) return [true, [`Skipped by the '${cfg.skip_label}' label.`], "skipped"];
  const br = currentBranch(root, branch);
  const [changes, , mb] = collectChanges(root, baseRef, rev);
  if (!Object.keys(changes).length) return [true, [], cfg.mode];
  const report = readReport(root, br, rev);
  if (report === null) {
    if (Object.entries(changes).every(([p, c]) => needsNoQuestions(p, c.mode, cfg)))
      return [true, ["Only ignored files changed (e.g. lockfiles) — no report needed."], cfg.mode];
    return [false, [`No ownership report for branch '${br}' (${reportPath(br)}). ${CHECK_ME_HINT}`], cfg.mode];
  }
  const st = fileStates(root, changes, report, rev, mb);
  const by = (s: State) => Object.keys(changes).filter((p) => st[p] === s);
  const problems: string[] = [];
  const unverifiedSensitive = Object.entries(changes)
    .filter(([p, c]) => isSensitive(p, c.mode, cfg) && !get(report.verified, p)?.length)
    .map(([p]) => p);
  if (by("new").length) problems.push(`Changed after the check (not in the report): ${by("new").join(", ")}`);
  if (by("stale").length)
    problems.push(`Changed after the check (differs from what was verified): ${by("stale").join(", ")}`);
  if (by("rebased").length)
    problems.push(
      `Verified before a rebase — save the report again, no new questions needed: ${by("rebased").join(", ")}`,
    );
  if (unverifiedSensitive.length)
    problems.push(`Sensitive files not explicitly verified: ${unverifiedSensitive.join(", ")}`);
  const len = charCount(trimSummary(report.summary));
  const shortOk = () => len >= cfg.small_summary_chars && smallChange(root, baseRef, mb, rev, changes, cfg).small;
  if (len < cfg.min_summary_chars && !shortOk()) problems.push("The developer's summary is missing or too short.");
  if (problems.length && !(by("rebased").length && problems.length === 1)) problems.push(CHECK_ME_HINT);
  return [problems.length === 0, problems, cfg.mode];
}

/** After a successful save: delete the input file if, and only if, it is this
 *  repo's REPORT_INPUT. Any other file passed to --input is left alone. */
export function deleteReportInputFile(input: string, repo: string | null): string {
  try {
    const abs = resolve(input);
    const root = realpathSync(repoRoot(repo));
    if (join(realpathSync(dirname(abs)), basename(abs)) !== join(root, REPORT_INPUT)) return "";
    unlinkSync(abs);
    return ` Removed ${REPORT_INPUT}.`;
  } catch {
    return "";
  }
}
