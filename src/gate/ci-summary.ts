// What CI shows reviewers: the job summary and annotations. Only what was verified,
// never scores, wrong answers or attempts, and PR-author text is escaped.
import { get, isRecord, own } from "../util.js";
import { type Config, DEFAULT_CONFIG, isSensitive, loadConfig, rulesFromBase } from "./config.js";
import { resolveBase } from "./git.js";
import { type Report, readReport, reportPath } from "./report.js";
import { GATE_VERSION, sorted, splitLines } from "./shared.js";

/** Report text comes from the PR author: no HTML, images, links, table breaks
 *  or code spans in the reviewer's summary. */
export function escapeMarkdown(text: string): string {
  let t = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  for (const ch of ["\\", "[", "]", "|", "`", "*", "_"]) t = t.split(ch).join(`\\${ch}`);
  return t;
}

export function jobSummary(
  root: string,
  branch: string,
  rev: string,
  base: string | null,
  passed: boolean,
  messages: string[],
  mode: string,
): string {
  const icon = passed ? "✅" : mode === "required" ? "❌" : "⚠️";
  const title =
    mode === "off"
      ? "Ownership check is off"
      : mode === "skipped"
        ? "Ownership check skipped by label"
        : passed
          ? "Ownership check passed"
          : "Ownership check failed";
  const out = [`## ${icon} ${title}`, ""];
  if (messages.length) out.push(...messages.map((m) => `- ${escapeMarkdown(m)}`), "");
  let report: Report | null = null;
  try {
    report = readReport(root, branch, rev);
  } catch {
    report = null;
  }
  if (report) {
    let cfg: Pick<Config, "sensitive"> = DEFAULT_CONFIG;
    try {
      cfg = rulesFromBase(root, resolveBase(root, loadConfig(root, rev), base));
    } catch {
      /* defaults */
    }
    out.push(
      "### The developer's summary",
      "",
      ...splitLines(report.summary.trim()).map((l) => `> ${escapeMarkdown(l)}`),
      "",
      "### Verified understanding",
      "",
      "| File | Concepts the developer explained |",
      "|---|---|",
    );
    for (const path of sorted(Object.keys(report.verified))) {
      const entry = get(report.files, path);
      const mode = isRecord(entry) && typeof entry.mode === "string" ? entry.mode : "100644";
      const tag = isSensitive(path, mode, cfg) ? " 🔒" : "";
      out.push(
        `| ${escapeMarkdown(path)}${tag} | ${(get(report.verified, path) ?? []).map(escapeMarkdown).join("; ")} |`,
      );
    }
    const rest = sorted(Object.keys(report.files).filter((p) => !own(report!.verified, p)));
    if (rest.length)
      out.push(
        "",
        `<details><summary>Also in this change, no specific questions (${rest.length})</summary>`,
        "",
        ...rest.map((p) => `- ${escapeMarkdown(p)}`),
        "",
        "</details>",
      );
    out.push(
      "",
      `<sub>🔒 sensitive · report: \`${reportPath(branch)}\` · gate v${GATE_VERSION}. The report shows what was verified, never scores or mistakes.</sub>`,
    );
  }
  return `${out.join("\n")}\n`.slice(0, 60_000);
}

export function annotate(kind: string, messages: string[]): void {
  if (process.env.GITHUB_ACTIONS === "true")
    for (const m of messages) process.stdout.write(`::${kind} title=Ownership check::${m}\n`);
}
