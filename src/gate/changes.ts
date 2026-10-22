// What a change is: the files it touches, fingerprinted by git blob id, and whether each
// still matches what was verified (directly, or replayed onto a newer base with a 3-way merge).
//
// For each file the report records the git blob id and mode of the verified
// content, plus the blob id it was changed from. No diff text is hashed, so
// user git config can't make local and CI disagree. If the base moves on
// (merge or rebase), the report still holds when a 3-way merge proves the only
// new differences came from the base; anything else is "stale".
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, isSensitive, noQuestions } from "./config.js";
import { WORKTREE_SAFE, decodePath, git, gitBytes, gitEnv, hasFile, readBlob, refExists, run, showSmall, splitNul, withWorktreeIndex } from "./git.js";
import { matches } from "./glob.js";
import { Report } from "./report.js";
import { FEATURES_RE, GATE_FILES, GATE_REL, GateError, REGULAR_MODES, REPORT_INPUT, ZERO_SHA, dict, get, isObj, own, sorted, splitLines } from "./shared.js";

// Exact shapes only (no subfolders, markdown only), so nothing executable can hide here.
const PLUMBING_RE = /^\.learning\/(checks\/[^/]+\.md|decisions\/[^/]+\.md|map\.md|[^/]+\.local\.md)$/;

interface Change { mode: string; blob: string; base: string; base_mode: string }

type Changes = Record<string, Change>;

/** Gate-control files (CODEOWNERS-protected) by path; the team's notes and
 *  reports only as plain, non-executable files — a symlink, executable or
 *  submodule at those paths is a normal change like any other. */
export function isPlumbing(path: string, mode = "100644"): boolean {
  if (GATE_FILES.includes(path)) return true;
  // Exactly this path and only as a plain file: a pattern would let code hide in look-alikes.
  if (path === REPORT_INPUT) return mode === "100644";
  return PLUMBING_RE.test(path) && (mode === "100644" || mode === "000000");
}

/** install's own .gitignore edit: the old file plus exactly one line,
 *  REPORT_INPUT, byte for byte. Any other edit to .gitignore is a change.
 *  This keeps the PR that installs the gate free of anything to verify. */
function isReportIgnoreEdit(root: string, path: string, c: Change): boolean {
  if (path !== ".gitignore" || c.mode !== "100644") return false;
  const before = c.base === ZERO_SHA ? Buffer.alloc(0) : c.base_mode === "100644" ? readBlob(root, c.base) : null;
  const after = readBlob(root, c.blob);
  if (!before || !after) return false;
  return after.equals(withIgnoreLine(before));
}

/** `text` with REPORT_INPUT appended as its own line: what install writes. */
export function withIgnoreLine(text: Buffer): Buffer {
  const sep = text.length && text[text.length - 1] !== 0x0a ? "\n" : "";
  return Buffer.concat([text, Buffer.from(`${sep}${REPORT_INPUT}\n`)]);
}

/** [{path: {mode, blob, base, base_mode}}, untracked paths, fork point] for
 *  every file the change touches against the fork point, gate plumbing
 *  excluded. rev=null means the working tree, as `git add -A` would commit it.
 *  Only `git diff --raw` is used: its output doesn't depend on diff.* config,
 *  attributes, or GIT_DIFF_OPTS. */
export function collectChanges(root: string, base: string, rev?: string | null): [Changes, Set<string>, string] {
  const target = rev || "HEAD";
  if (!refExists(root, target)) throw new GateError("This branch has no commits yet — commit something first.");
  const mb = git(root, ["merge-base", base, target], { check: false }).trim();
  if (!mb) throw new GateError(`No common history between ${base} and ${target}. In CI, check out with fetch-depth: 0.`);
  const rawArgs = ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--ignore-submodules=none"];
  let raw: Buffer;
  let untracked = new Set<string>();
  if (rev) raw = gitBytes(root, [...rawArgs, mb, rev]);
  else {
    raw = withWorktreeIndex(root, (env) => gitBytes(root, [...rawArgs, "--cached", mb], { env }));
    const out = gitBytes(root, [...WORKTREE_SAFE, "ls-files", "--others", "--exclude-standard", "-z"]);
    untracked = new Set(splitNul(out).filter((p) => p.length).map(decodePath));
  }
  const fields = splitNul(raw);
  const changes: Changes = dict();
  let i = 0;
  while (i < fields.length - 1) {
    const meta = fields[i].toString("latin1");
    if (!meta.startsWith(":")) {
      i++;
      continue;
    }
    const [oldmode, newmode, oldsha, newsha] = meta.slice(1).split(/\s+/);
    const path = decodePath(fields[i + 1]);
    i += 2;
    const change = { mode: newmode, blob: newsha, base: oldsha, base_mode: oldmode };
    if (!isPlumbing(path, newmode) && !isReportIgnoreEdit(root, path, change)) changes[path] = change;
  }
  return [Object.fromEntries(sorted(Object.keys(changes)).map((k) => [k, changes[k]])), untracked, mb];
}

function merge3(ours: Buffer, base: Buffer, theirs: Buffer): Buffer | null {
  const dir = mkdtempSync(join(tmpdir(), "ownership-gate-merge-"));
  try {
    const paths = ([["ours", ours], ["base", base], ["theirs", theirs]] as const).map(([name, data]) => {
      const p = join(dir, name);
      writeFileSync(p, data);
      return p;
    });
    const r = run("git", ["merge-file", "-p", "-q", ...paths], { cwd: dir, env: gitEnv() });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isChange = (v: unknown): v is Change =>
  isObj(v) && ["mode", "blob", "base", "base_mode"].every((k) => typeof v[k] === "string");

/** 'exact' if `current` is the verified change; 'merged' if it is the verified
 *  change carried onto a newer base; null otherwise. For 'merged', the only
 *  accepted difference is the base's own edits: we replay them onto the
 *  verified content with a 3-way merge and require the result to equal the
 *  current content byte for byte. The file mode is merged the same way.
 *  Anything else (a conflict, a binary file, a missing object) is a change. */
function matchKind(root: string, verified: unknown, current: Change): "exact" | "merged" | null {
  if (!isChange(verified)) return null;
  if (verified.mode === current.mode && verified.blob === current.blob && verified.base === current.base && verified.base_mode === current.base_mode) return "exact";
  const expectedMode = verified.mode === verified.base_mode ? current.base_mode : verified.mode;
  if (current.mode !== expectedMode) return null;
  // Base content unchanged: only a base mode change can explain a difference.
  if (verified.base === current.base) return current.blob === verified.blob ? "merged" : null;
  if (!REGULAR_MODES.includes(current.mode) || !REGULAR_MODES.includes(verified.mode)) return null;
  if ([verified.blob, verified.base, current.base, current.blob].includes(ZERO_SHA)) return null;
  const blobs = [verified.blob, verified.base, current.base, current.blob].map((s) => readBlob(root, s));
  if (blobs.some((b) => b === null)) return null;
  const [vBlob, vBase, cBase, cBlob] = blobs as Buffer[];
  if (blobs.some((b) => (b as Buffer).subarray(0, 8000).includes(0))) return null; // binary: must be re-verified
  const merged = merge3(vBlob, vBase, cBase);
  return merged !== null && merged.equals(cBlob) ? "merged" : null;
}

/** Blob ids introduced on the branch (reachable from target, not from the fork
 *  point). Content verified before a rebase isn't among them, and CI won't
 *  have it — so such files must be re-saved. */
function branchBlobs(root: string, target: string, mb: string): Set<string> {
  const out = git(root, ["rev-list", "--objects", target, "--not", mb], { check: false });
  return new Set(splitLines(out).filter(Boolean).map((l) => l.split(" ", 1)[0]));
}

export const SAME = ["ok", "rebased"];

// states where the verified change is intact
export type State = "new" | "ok" | "stale" | "rebased";

/** new: not in the report · ok: the verified change · stale: changed since ·
 *  rebased: the verified change on a newer base, but the verified content is
 *  no longer in the branch's history (e.g. after a rebase) — re-save, no questions. */
export function states(root: string, changes: Changes, old: Report | null, target: string, mb: string): Record<string, State> {
  const oldFiles = old ? old.files : dict<unknown>();
  let reachable: Set<string> | null = null;
  const out: Record<string, State> = dict();
  for (const [p, c] of Object.entries(changes)) {
    if (!own(oldFiles, p)) {
      out[p] = "new";
      continue;
    }
    const kind = matchKind(root, get(oldFiles, p), c);
    if (kind === "exact") out[p] = "ok";
    else if (kind === "merged") {
      reachable ??= branchBlobs(root, target, mb);
      out[p] = reachable.has((get(oldFiles, p) as Change).blob) ? "ok" : "rebased";
    } else out[p] = "stale";
  }
  return out;
}

/** One rule, shared by status and save. A file needs questions if it is
 *  sensitive, or if a report exists and the file is new or changed since then
 *  — unless it was verified before and is unchanged. Ignored files never need
 *  questions unless they're also sensitive. Untracked files count like any
 *  other: exempting them would let new code into a report unverified. */
export function needsVerification(changes: Changes, st: Record<string, State>, old: Report | null, cfg: Config): string[] {
  const oldVerified = old ? old.verified : dict<string[]>();
  const out: string[] = [];
  for (const [path, c] of Object.entries(changes)) {
    if (noQuestions(path, c.mode, cfg)) continue;
    if (SAME.includes(st[path]) && get(oldVerified, path)?.length) continue;
    if (isSensitive(path, c.mode, cfg) || (old !== null && !SAME.includes(st[path]))) out.push(path);
  }
  return out;
}

/** Does the base branch's gate (the copy CI runs) list `feature` in its header? */
function baseGateHas(root: string, baseRef: string, feature: string): boolean {
  if (!hasFile(root, baseRef, GATE_REL)) return false;
  try {
    const head = showSmall(root, baseRef, GATE_REL, 8 * 1024 * 1024).slice(0, 4096);
    return (FEATURES_RE.exec(head)?.[1] ?? "").trim().split(/\s+/).includes(feature);
  } catch {
    return false;
  }
}

/** Added + removed lines in `paths` between the fork point and `rev` (the
 *  working tree, as `git add -A` would commit it, when rev is null); null if
 *  one of them is binary. The diff options are fixed, so local diff config
 *  (algorithm, textconv, external tools) can't change the count. */
function changedLines(root: string, mb: string, rev: string | null, paths: Set<string>): number | null {
  const args = ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--diff-algorithm=myers", "--ignore-submodules=none"];
  const raw = rev ? gitBytes(root, [...args, mb, rev]) : withWorktreeIndex(root, (env) => gitBytes(root, [...args, "--cached", mb], { env }));
  let total = 0;
  for (const rec of splitNul(raw)) {
    const t1 = rec.indexOf(9);
    const t2 = t1 < 0 ? -1 : rec.indexOf(9, t1 + 1);
    if (t2 < 0 || !paths.has(decodePath(rec.subarray(t2 + 1)))) continue;
    const added = rec.subarray(0, t1).toString("latin1");
    const removed = rec.subarray(t1 + 1, t2).toString("latin1");
    if (added === "-" || removed === "-") return null;
    total += Number(added) + Number(removed);
  }
  return total;
}

export const changedLinesText = (n: number) => `${n} changed line${n === 1 ? "" : "s"}`;

interface Small {
  small: boolean;
  lines: number | null; // null: not counted (nothing to count, or something sensitive / binary)
  note: string | null;
}

/** The fast path: a change is small when its non-ignored files add and remove
 *  at most small_change_lines lines in total, and nothing in it is sensitive, a
 *  submodule or binary. It then needs a summary of small_summary_chars instead
 *  of min_summary_chars; everything else is checked as usual. It only applies
 *  when the base branch's gate knows it, so local and CI always agree. */
export function smallChange(root: string, baseRef: string, mb: string, rev: string | null, changes: Changes, cfg: Config): Small {
  const no = (lines: number | null = null, note: string | null = null): Small => ({ small: false, lines, note });
  const entries = Object.entries(changes);
  if (!cfg.small_change_lines || !entries.length) return no();
  if (entries.some(([p, c]) => isSensitive(p, c.mode, cfg) || c.base_mode === "160000")) return no();
  const counted = new Set(entries.filter(([p]) => !matches(p, cfg.ignore)).map(([p]) => p));
  const lines = changedLines(root, mb, rev, counted);
  if (lines === null || lines > cfg.small_change_lines) return no(lines);
  if (!baseGateHas(root, baseRef, "small-change")) {
    return no(lines, `This would count as a small change (${changedLinesText(lines)}), but the base branch's gate predates the fast path, so CI would ask for the full check. Upgrade it with \`gate.mjs install --upgrade\` in its own PR.`);
  }
  return { small: true, lines, note: null };
}
