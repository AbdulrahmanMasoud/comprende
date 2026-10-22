/**
 * Ownership gate for the comprende plugin: its command line, and the entry
 * point of the bundled dist/gate.mjs.
 *
 * Ties an "I understand this change" report to the exact change it covers, and
 * refuses pushes/merges when the report is missing or the change moved on.
 *
 * Bundled into one dependency-free file (dist/gate.mjs) that imports only
 * `node:` built-ins — those can never be shadowed by files in a repo. The same
 * file is copied into each repo as .learning/gate.mjs, and runs in the git
 * hook, the Claude Code hook, the MCP server, and CI, with nothing to install.
 */
import { appendFileSync, readFileSync, readSync } from "node:fs";
import { collectChanges, isPlumbing } from "./changes.js";
import { ci, jobSummary, mdSafe } from "./ci-summary.js";
import { formatStatus, removeReportInput, save, status, verify } from "./commands.js";
import { Config, isSensitive } from "./config.js";
import { currentBranch, repoRoot } from "./git.js";
import { ALWAYS_ON, claudeHook, installHooks, prePush, sessionStart } from "./hooks.js";
import { isPushCommand } from "./push-detect.js";
import { parseReport, readReport, renderReport, reportRelpath } from "./report.js";
import { CHECK_NAME, WORKFLOW, install, mergeClaudeSettings, protect } from "./setup.js";
import { GATE_FILES, GATE_REL, GATE_VERSION, GateError, isObj, sorted } from "./shared.js";

const HELP = `Ownership gate (comprende)

Commands (run from inside the repo, or pass --repo):
  status         Which changed files are new / stale / ok vs. the report   [--json]
  save           Write the report from JSON {"summary", "verified": {path: [concepts]}} on stdin,
                 or --input .learning/report.local.json (deleted after a successful save)
  verify         Check a commit (default HEAD) against its report — used by CI   [--json]
  pre-push       Git pre-push hook entry point (reads refs from stdin)
  claude-hook    Claude Code PreToolUse hook entry point (reads JSON from stdin)
  session-start  Claude Code SessionStart hook (plugin): the always-on note; in gated repos, the git hook
  install        Add the gate, config, CI workflow, Claude hook and git hook to a repo
  install-hooks  Install only the local git pre-push hook (once per clone)
  protect        Create the GitHub ruleset that makes the check required (gh; dry run by default)
  version        Print the gate version

Common options: --repo PATH  --base REF  --branch NAME
`;

function readStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      if (code === "EOF" || code === "ENOTCONN" || code === "EINVAL" || code === "EBADF") break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface Args { cmd: string; opts: Record<string, string | boolean>; rest: string[] }

const FLAGS = new Set(["json", "from-plugin", "upgrade", "apply", "no-code-owners", "help"]);

const VALUE_OPTS = new Set(["repo", "base", "branch", "input", "rev", "labels-json", "owner", "approvals"]);

function parseArgs(argv: string[]): Args {
  const [cmd = "", ...tail] = argv;
  const opts: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (FLAGS.has(k) && v === undefined) opts[k] = true;
      else if (VALUE_OPTS.has(k)) {
        const val = v ?? tail[++i];
        if (val === undefined || (v === undefined && val.startsWith("--"))) throw new UsageError(`--${k} needs a value`);
        opts[k] = val;
      } else if (cmd === "pre-push") rest.push(a);
      else throw new UsageError(`unknown option --${k}`);
    } else rest.push(a);
  }
  if (rest.length && !["pre-push", "__test"].includes(cmd)) throw new UsageError(`unexpected argument ${rest[0]}`);
  return { cmd, opts, rest };
}

class UsageError extends Error {}

/** Internal functions, JSON in / JSON out, for the black-box test suite. */
function testCall(fn: string, a: unknown[]): unknown {
  const s = (i: number) => (a[i] === null || a[i] === undefined ? null : String(a[i]));
  const consts: Record<string, unknown> = { GATE_VERSION, GATE_FILES, WORKFLOW, CHECK_NAME, REPO_GATE: GATE_REL, ALWAYS_ON };
  if (fn in consts) return consts[fn];
  switch (fn) {
    case "collect_changes": {
      const [c, u, mb] = collectChanges(repoRoot(s(0)), String(a[1]), s(2));
      return [c, sorted(u), mb];
    }
    case "read_report":
      return readReport(repoRoot(s(0)), String(a[1]), s(2));
    case "merge_claude_settings":
      return mergeClaudeSettings(String(a[0]));
    case "is_push_command":
      return isPushCommand(String(a[0]));
    case "is_plumbing":
      return isPlumbing(String(a[0]), a[1] === undefined ? undefined : String(a[1]));
    case "is_sensitive":
      return isSensitive(String(a[0]), String(a[1]), a[2] as Config);
    case "md_safe":
      return mdSafe(String(a[0]));
    case "report_relpath":
      return reportRelpath(String(a[0]));
    case "render_report":
      return renderReport(a[0] as Parameters<typeof renderReport>[0]);
    case "parse_report":
      return parseReport(String(a[0]));
    default:
      throw new GateError(`unknown test function ${fn}`);
  }
}

export function main(argv: string[]): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { cmd, opts, rest } = args;
  const o = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : null);
  const out = (s: string) => process.stdout.write(s + "\n");
  try {
    switch (cmd) {
      case "":
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(HELP);
        return cmd ? 0 : 2;
      case "version":
        out(String(GATE_VERSION));
        return 0;
      case "status": {
        const st = status(o("repo"), o("base"), o("branch"));
        out(opts.json ? JSON.stringify(st, null, 2) : formatStatus(st));
        return 0;
      }
      case "save": {
        const raw = o("input") ? readFileSync(o("input") as string, "utf8") : readStdin();
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          throw new GateError(`Input is not valid JSON: ${(e as Error).message}`);
        }
        if (!isObj(payload)) throw new GateError('Input must be a JSON object with "summary" and "verified".');
        const saved = save(payload, o("repo"), o("base"), o("branch"));
        out(o("input") ? saved + removeReportInput(o("input") as string, o("repo")) : saved);
        return 0;
      }
      case "verify": {
        let labels: string[] = [];
        const lj = o("labels-json");
        if (lj && lj.trim()) {
          try {
            const parsed = JSON.parse(lj);
            if (!Array.isArray(parsed)) throw new Error("not a list");
            labels = parsed.map(String);
          } catch {
            throw new GateError("--labels-json must be a JSON list of label names.");
          }
        }
        const rev = o("rev") ?? "HEAD";
        const [passed, messages, mode] = verify(o("repo"), o("base"), o("branch"), rev, labels);
        if (opts.json) {
          out(JSON.stringify({ passed, messages, mode }));
          return 0;
        }
        const summaryPath = process.env.GITHUB_STEP_SUMMARY;
        if (summaryPath) {
          try {
            const root = repoRoot(o("repo"));
            appendFileSync(summaryPath, jobSummary(root, currentBranch(root, o("branch")), rev, o("base"), passed, messages, mode), "utf8");
          } catch {
            /* a summary is a nicety, never a failure */
          }
        }
        if (passed) {
          if (messages.length) ci(mode === "skipped" ? "warning" : "notice", messages);
          out(messages.length ? messages[0] : mode === "off" ? "Ownership check is off." : "Ownership check passed.");
          return 0;
        }
        ci(mode === "required" ? "error" : "warning", messages);
        process.stderr.write("Ownership check failed:\n- " + messages.join("\n- ") + "\n");
        return mode === "required" ? 1 : 0;
      }
      case "pre-push":
        return prePush(readStdin(), o("repo"));
      case "claude-hook":
        return claudeHook(readStdin(), Boolean(opts["from-plugin"]));
      case "session-start":
        out(JSON.stringify(sessionStart(readStdin())));
        return 0;
      case "install":
      case "install-hooks":
      case "protect": {
        let lines: string[];
        if (cmd === "install") lines = install(o("repo"), Boolean(opts.upgrade), o("owner"));
        else if (cmd === "install-hooks") lines = installHooks(o("repo"));
        else {
          const n = o("approvals");
          if (n !== null && !/^\d+$/.test(n)) throw new GateError("--approvals must be between 0 and 10.");
          const approvals = n === null ? 1 : Number(n);
          lines = protect(o("repo"), Boolean(opts.apply), approvals, !opts["no-code-owners"]);
        }
        out(opts.json ? JSON.stringify(lines) : lines.join("\n"));
        return 0;
      }
      case "__test": {
        const [fn, json = "[]"] = rest;
        out(JSON.stringify(testCall(fn, JSON.parse(json))));
        return 0;
      }
      default:
        process.stderr.write(`unknown command ${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (!(e instanceof GateError)) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!code) throw e; // a real bug: let it surface with a stack trace
    }
    process.stderr.write(`ownership gate: ${msg}\n`);
    ci("error", [msg]);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
