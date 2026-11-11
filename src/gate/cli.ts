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
 * hook, the AI tools' hooks, the MCP server, and CI, with nothing to install.
 */

import { appendFileSync, readFileSync, readSync } from "node:fs";
import { isRecord } from "../util.js";
import { AGENTS } from "./agents/index.js";
import { jobSummary } from "./ci-summary.js";
import { deleteReportInputFile, formatStatus, save, status, verify } from "./commands.js";
import { currentBranch, repoRoot } from "./git.js";
import type { HookSource } from "./hook-copies.js";
import { agentHook, installHooks, prePush, sessionStart } from "./hooks.js";
import { install } from "./install.js";
import { type AnnotationKind, ciPlatform, REPO_PLATFORM } from "./platforms/index.js";
import { GATE_VERSION, GateError, oneLine } from "./shared.js";
import { testCall } from "./test-hooks.js";

const HELP = `Ownership gate (comprende)

Commands (run from inside the repo, or pass --repo):
  status         Which changed files are new / stale / ok vs. the report   [--json]
  save           Write the report from JSON {"summary", "verified": {path: [concepts]}} on stdin,
                 or --input .learning/report.local.json (deleted after a successful save)
  verify         Check a commit (default HEAD) against its report — used by CI   [--json]
  pre-push       Git pre-push hook entry point (reads refs from stdin)
  agent-hook     PreToolUse hook entry point for AI tools (reads JSON from stdin)   [--agent ID]
  claude-hook    The same as agent-hook. install and the plugin still call this name, which older gates know
  session-start  SessionStart hook: the always-on note; in gated repos, the git hook   [--agent ID]
  install        Add the gate, config, CI workflow, the AI tools' repo hook files and the git hook to a repo
  install-hooks  Install only the local git pre-push hook (once per clone)
  protect        Make the check required on the default branch (GitHub: a ruleset, through gh; dry run by default)
  version        Print the gate version

Common options: --repo PATH  --base REF  --branch NAME
--agent ID: the AI tool running the hook (${AGENTS.map((a) => a.id).join(", ")}). Without it, the payload tells.
--from-plugin | --from-repo: which hook file runs a hook, a plugin's or the repo's. Without either,
  agent-hook is the repo's and session-start the plugin's, as in older hook files.
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

interface Args {
  cmd: string;
  opts: Record<string, string | boolean>;
  rest: string[];
}

const FLAGS = new Set(["json", "from-plugin", "from-repo", "upgrade", "apply", "no-code-owners", "help"]);

const VALUE_OPTS = new Set(["repo", "base", "branch", "input", "rev", "labels-json", "owner", "approvals", "agent"]);

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
        if (val === undefined || (v === undefined && val.startsWith("--")))
          throw new UsageError(`--${k} needs a value`);
        opts[k] = val;
      } else if (cmd === "pre-push") rest.push(a);
      else throw new UsageError(`unknown option --${k}`);
    } else rest.push(a);
  }
  if (rest.length && !["pre-push", "__test"].includes(cmd)) throw new UsageError(`unexpected argument ${rest[0]}`);
  return { cmd, opts, rest };
}

class UsageError extends Error {}

/** Which hook file a hook run comes from. Older hook files pass neither flag:
 *  the repo's .claude/settings.json runs `claude-hook`, and the plugin's
 *  hooks.json ran `session-start`. */
function hookSource(cmd: string, opts: Args["opts"]): HookSource {
  if (opts["from-plugin"] && opts["from-repo"])
    throw new UsageError("--from-plugin and --from-repo can't both be given");
  if (opts["from-plugin"]) return "plugin";
  if (opts["from-repo"]) return "repo";
  return cmd === "session-start" ? "plugin" : "repo";
}

// A hook must never exit 2 by accident: Claude Code and Cursor read 2 as
// "block", and git blocks a push on any non-zero exit. So a usage error in a
// hook entry point fails open: an older gate that doesn't know an option a newer
// hook file passes must not block every command. The value is the exit code that
// fails open for whoever runs that entry point.
const FAIL_OPEN_EXIT: Readonly<Record<string, number>> = {
  "agent-hook": 1,
  "claude-hook": 1,
  "session-start": 1,
  "pre-push": 0,
};

export function main(argv: string[]): number {
  let args: Args;
  let source: HookSource;
  try {
    args = parseArgs(argv);
    source = hookSource(args.cmd, args.opts);
  } catch (e) {
    const failOpen = Object.hasOwn(FAIL_OPEN_EXIT, argv[0] ?? "") ? FAIL_OPEN_EXIT[argv[0]] : undefined;
    if (failOpen !== undefined) {
      process.stderr.write(`ownership gate: ${(e as Error).message}; skipping this hook\n`);
      return failOpen;
    }
    process.stderr.write(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { cmd, opts, rest } = args;
  const o = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : null);
  const out = (s: string) => process.stdout.write(`${s}\n`);
  // The CI this runs in, if any: where annotations and the reviewer summary go.
  const platform = ciPlatform(process.env);
  const annotate = (kind: AnnotationKind, messages: string[]) =>
    process.stdout.write(platform.annotations(kind, messages, process.env));
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
        if (!isRecord(payload)) throw new GateError('Input must be a JSON object with "summary" and "verified".');
        const saved = save(payload, o("repo"), o("base"), o("branch"));
        out(o("input") ? saved + deleteReportInputFile(o("input") as string, o("repo")) : saved);
        return 0;
      }
      case "verify": {
        const ci = platform.ciContext(process.env);
        let labels: string[] = [...(ci.labels ?? [])];
        const lj = o("labels-json");
        if (lj?.trim()) {
          try {
            const parsed = JSON.parse(lj);
            if (!Array.isArray(parsed)) throw new Error("not a list");
            labels = parsed.map(String);
          } catch {
            throw new GateError("--labels-json must be a JSON list of label names.");
          }
        }
        const rev = o("rev") ?? "HEAD";
        const base = o("base") ?? ci.baseRef;
        const [passed, messages, mode] = verify(o("repo"), { base, branch: o("branch"), rev, labels });
        if (opts.json) {
          out(JSON.stringify({ passed, messages, mode }));
          return 0;
        }
        const summaryPath = platform.reviewerSummaryFile(process.env);
        if (summaryPath) {
          try {
            const root = repoRoot(o("repo"));
            appendFileSync(
              summaryPath,
              jobSummary(root, currentBranch(root, o("branch")), rev, base, passed, messages, mode),
              "utf8",
            );
          } catch {
            /* a summary is a nicety, never a failure */
          }
        }
        if (passed) {
          if (messages.length) annotate(mode === "skipped" ? "warning" : "notice", messages);
          out(
            messages.length
              ? oneLine(messages[0])
              : mode === "off"
                ? "Ownership check is off."
                : "Ownership check passed.",
          );
          return 0;
        }
        annotate(mode === "required" ? "error" : "warning", messages);
        process.stderr.write(`Ownership check failed:\n- ${messages.map(oneLine).join("\n- ")}\n`);
        return mode === "required" ? 1 : 0;
      }
      case "pre-push":
        return prePush(readStdin(), o("repo"));
      case "agent-hook":
      case "claude-hook": {
        const reply = agentHook(readStdin(), source, o("agent"));
        process.stdout.write(reply.stdout);
        process.stderr.write(reply.stderr);
        return reply.exitCode;
      }
      case "session-start":
        out(sessionStart(readStdin(), source, o("agent")));
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
          lines = REPO_PLATFORM.protect(repoRoot(o("repo")), {
            apply: Boolean(opts.apply),
            approvals,
            codeOwners: !opts["no-code-owners"],
          });
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
        // Exit 1, not 2: the unknown command may be a hook entry point that a
        // newer hook file calls on this older gate.
        process.stderr.write(`ownership gate: unknown command ${cmd}; run \`gate.mjs help\` for the list\n`);
        return 1;
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (!(e instanceof GateError)) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!code) throw e; // a real bug: let it surface with a stack trace
    }
    process.stderr.write(`ownership gate: ${oneLine(msg)}\n`);
    annotate("error", [msg]);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
