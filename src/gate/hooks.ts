// The hook entry points: the AI tools' PreToolUse and SessionStart, through their
// adapters (agents/), and git's pre-push, plus installing the pinned pre-push hook.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isFile, isSymlink, lstat } from "../util.js";
import { type Agent, type HookEnv, type HookReply, resolveAgent, UNKNOWN_AGENT_NAMES } from "./agents/index.js";
import { checkForHook } from "./commands.js";
import { loadConfig } from "./config.js";
import { git, repoRoot, resolveBase } from "./git.js";
import { claimed, claimedGateContext, type HookRun, type HookSource, stepsAside } from "./hook-copies.js";
import { decisionReply, SILENT_ALLOW, sessionContextReply } from "./hook-replies.js";
import { isPushCommand } from "./push-detect.js";
import { uncommittedReport } from "./report.js";
import { CONFIG_PATH, GATE_ATTRIBUTES_LINE, GATE_REL, SELF, splitLines, withoutBom, ZERO_SHA } from "./shared.js";

/** The hook's payload and the adapter that reads it, or no adapter when stdin
 *  isn't JSON or `--agent` names an unknown tool. Never throws. */
function readHookInput(stdinText: string, requested: string | null): { payload: unknown; agent: Agent | null } {
  try {
    const payload: unknown = JSON.parse(withoutBom(stdinText) || "{}");
    return { payload, agent: resolveAgent(payload, process.env, requested) };
  } catch {
    return { payload: undefined, agent: null };
  }
}

/** The PreToolUse hook, for every AI tool: the adapter reads the payload, and the
 *  reply is in the adapter's format, by default exit 2 with stderr to block and
 *  nothing to allow (hook-replies.ts). It checks the current branch; pushes of other
 *  branches are checked by the pre-push hook and CI. Outside a repo with the gate
 *  installed, for an unknown tool, or on an unexpected crash, it allows the call:
 *  this hook is a reminder; CI is the lock. When several copies of the hook run
 *  on the command, only one checks (hook-copies.ts). The plugin never executes
 *  code from the repo it's looking at; it applies its own logic to the repo's data. */
export function agentHook(stdinText: string, source: HookSource, requested: string | null): HookReply {
  const { payload, agent } = readHookInput(stdinText, requested);
  if (!agent) return SILENT_ALLOW;
  const env: HookEnv = process.env;
  const allow = decisionReply(agent, { allow: true });
  const run: HookRun = { agent, event: "shell", source, requested };
  let root: string;
  try {
    const command = agent.shellCommand(payload);
    if (command === null || !isPushCommand(command)) return allow;
    const dir = agent.projectDir(payload, env);
    if (dir === null) return allow; // the tool didn't say which repo: step aside
    root = repoRoot(dir);
    if (!lstat(join(root, CONFIG_PATH))) return allow;
    if (stepsAside(run, root) || !claimed(run, payload, root)) return allow;
  } catch {
    return allow;
  }
  const check = checkForHook(root, { assistant: agent.names.assistant }, false);
  if ("skipped" in check || check.passed || check.mode !== "required") return allow;
  // The hook runs before the command, so `git commit … && git push` is checked
  // against the old HEAD. Say so when the fix is just a separate commit.
  const pending = uncommittedReport(root);
  if (pending) {
    return decisionReply(agent, {
      allow: false,
      reason:
        `Blocked by the ownership gate: the report ${pending} is saved but not committed. Commit it first, then push as a separate command. ` +
        "This hook checks the branch before a command runs, so a push in the same command as the commit is blocked too.",
    });
  }
  return decisionReply(agent, {
    allow: false,
    reason: `Blocked by the ownership gate:\n- ${check.problems.join("\n- ")}`,
  });
}

const MIN_NODE = 20;

// hooks/hooks.json carries the same note, naming no app, for a missing or unusable
// node: Claude Code and Cursor (which imports Claude Code plugins) both run it.
const nodeNote = (app: string) =>
  `Tell the user in one line that Comprende needs Node.js 20 or newer (install it from https://nodejs.org), then a restart of ${app}.`;

// How the line a plugin's session start always gives begins. A session without it
// had no plugin hooks run: the skill and the repo hook's note look for it.
export const PLUGIN_LINE_START = "Comprende is installed";

// Every session, so explanations don't depend on the request sounding like a
// wish to learn. Fixed text on purpose: nothing read from the repo goes into it.
export const ALWAYS_ON =
  `${PLUGIN_LINE_START}. Whenever you write or change code in this session, follow the comprende skill: ` +
  "explain only what's new, non-obvious, risky or a real decision, briefly, in the user's language and dialect.";

// COMPRENDE_QUIET=1 still sends a line, not nothing: the skill now loads for any
// code change, so it needs telling to stay quiet, and a session with no note at
// all reads to the skill as hooks that didn't run.
export const QUIET_MODE = `${PLUGIN_LINE_START}, in quiet mode: use the comprende skill only when the user asks for an explanation, or for the ownership gate.`;

/** What the repo's hook file says at session start, in a tool that can skip the
 *  plugin's hooks without a word: how the agent tells, and what it tells the user.
 *  The plugin may not be installed at all, so the note names both cases, and asks
 *  for both options: a real run had the agent tell a user without the plugin to
 *  re-trust hooks they never had. */
const pluginNotRunningNote = (agent: Agent, hint: string) =>
  `If this session didn't also get a note starting with "${PLUGIN_LINE_START}", Comprende's plugin isn't running in ${agent.names.app}: either it isn't installed, or its hooks were skipped. Tell the user once, in one line, in their language, with both options: ${hint}`;

const withLfEndings = (bytes: Buffer) => Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1");

export type GateCopyDifference = "none" | "repo-crlf" | "plugin-crlf" | "content";

/** How a repo's gate.mjs differs from the plugin's: not at all, only in CRLF
 *  line endings on one side (git's core.autocrlf on Windows), or in content.
 *  Only "none" is trusted: the other answers just change what the user is told. */
export function gateCopyDifference(repoCopy: Buffer, pluginCopy: Buffer): GateCopyDifference {
  if (repoCopy.equals(pluginCopy)) return "none";
  if (!withLfEndings(repoCopy).equals(withLfEndings(pluginCopy))) return "content";
  return repoCopy.includes("\r\n") ? "repo-crlf" : "plugin-crlf";
}

// Why the pre-push hook wasn't installed automatically. Fixed text, like the
// rest of the SessionStart context: nothing read from the repo goes into it.
const untrustedGateNote = (agent: Agent): Record<Exclude<GateCopyDifference, "none">, string> => ({
  content: `This repo's ${GATE_REL} differs from the plugin's copy, so the local pre-push hook was NOT installed automatically. If the user trusts this repo, they can run \`node ${GATE_REL} install-hooks\`; mention this in one line.`,
  "repo-crlf": `This repo's ${GATE_REL} differs from the plugin's copy only in its line endings: git's core.autocrlf checked it out with CRLF. The local pre-push hook trusts only a byte-identical copy, so it was NOT installed automatically. Tell the user in one line to run \`git -c core.autocrlf=false checkout -- ${GATE_REL}\`, then \`node ${GATE_REL} install\`, which adds \`${GATE_ATTRIBUTES_LINE}\` to .gitattributes so it stays that way.`,
  "plugin-crlf": `The plugin's own copy of gate.mjs has CRLF line endings (git's core.autocrlf, in an install from before Comprende 0.2.1), so it differs from this repo's ${GATE_REL} only in its line endings, and the local pre-push hook was NOT installed automatically. Tell the user in one line to update the plugin: ${agent.pluginUpdateHint}.`,
});

/** SessionStart hook: the stdout that adds context for the agent, in the
 *  adapter's format. A plugin's run gives the always-on line and, unless the
 *  repo's own hook file starts the session, the gate's context. A run from the
 *  repo's hook file gives the gate's context, and the tool's note for a plugin
 *  that isn't running, if it has one. Never throws — a session must always start. */
export function sessionStart(stdinText: string, source: HookSource, requested: string | null): string {
  const { payload, agent } = readHookInput(stdinText, requested);
  const run: HookRun | null = agent && { agent, event: "sessionStart", source, requested };
  if (run && !claimed(run, payload, run.agent.projectDir(payload, process.env) ?? ""))
    return sessionContextReply(agent, []);
  const lines: string[] = [];
  const node = process.versions.node;
  if (Number.parseInt(node, 10) < MIN_NODE)
    lines.push(
      `Comprende is running on Node.js ${node}, which is too old. ${nodeNote((agent?.names ?? UNKNOWN_AGENT_NAMES).app)}`,
    );
  if (source === "plugin") lines.push(process.env.COMPRENDE_QUIET === "1" ? QUIET_MODE : ALWAYS_ON);
  if (run) lines.push(...gatedRepoContext(run, payload));
  return sessionContextReply(agent, lines);
}

/** In a repo that uses the gate: tell the agent the repo is gated so the
 *  ownership-check protocol is followed (once, whichever copy claims it first),
 *  from the repo's hook file how to notice the plugin isn't running, and, from a
 *  plugin, install the local pre-push hook if this clone lacks it. Elsewhere: nothing. */
function gatedRepoContext(run: HookRun, payload: unknown): string[] {
  try {
    const dir = run.agent.projectDir(payload, process.env);
    if (dir === null) return [];
    const root = repoRoot(dir);
    if (!lstat(join(root, CONFIG_PATH))) return [];
    const cfg = loadConfig(root);
    if (cfg.mode === "off") return [];
    // Step aside before claiming: a copy that stepped aside but took the claim
    // would leave the copy it stepped aside for without the gate's context.
    const givesGateContext = !stepsAside(run, root) && claimedGateContext(run, payload, dir);
    const lines = givesGateContext
      ? [
          `This repository uses the ownership gate (mode: ${cfg.mode}). For any code change, follow the comprende skill's ownership check (read references/ownership-check.md): brief in-flight questions, a final check before commit/PR, and a saved report.`,
        ]
      : [];
    const hint = run.agent.pluginNotRunningHint;
    if (run.source === "repo" && hint) lines.push(pluginNotRunningNote(run.agent, hint));
    // A run from the repo's hook file is the repo's own gate.mjs: it can't vouch
    // for itself, so only a plugin's copy may set up the git hook.
    if (run.source === "plugin") lines.push(...autoInstallGitHook(run.agent, root));
    return lines;
  } catch {
    return [];
  }
}

/** Install the pre-push hook, which runs the repo's gate on every push, but only
 *  when the repo's gate.mjs is byte-identical to this (trusted) copy. Returns
 *  what to tell the agent. */
function autoInstallGitHook(agent: Agent, root: string): string[] {
  const repoGate = join(root, GATE_REL);
  if (process.env.OWNERSHIP_GATE_NO_AUTO_HOOK === "1" || !isFile(repoGate) || isSymlink(repoGate)) return [];
  const difference = SELF ? gateCopyDifference(readFileSync(repoGate), readFileSync(SELF)) : "content";
  if (difference !== "none") return [untrustedGateNote(agent)[difference]];
  const result = installHooks(root, true)[0];
  if (result.startsWith("installed") || result.startsWith("re-pinned"))
    return [
      "The local pre-push git hook was just installed in this clone; mention it to the user in one line (set OWNERSHIP_GATE_NO_AUTO_HOOK=1 to opt out).",
    ];
  return result.startsWith("SKIPPED") ? [`The gate's pre-push hook wasn't added: ${result}`] : [];
}

export function prePush(stdinText: string, repo?: string | null): number {
  let root: string, baseBranch: string;
  try {
    root = repoRoot(repo);
    const b = resolveBase(root, loadConfig(root), null);
    baseBranch = b.includes("/") ? b.slice(b.indexOf("/") + 1) : b;
  } catch (e) {
    process.stderr.write(`ownership gate: skipped (${(e as Error).message})\n`);
    return 0;
  }
  let failed = false;
  for (const line of splitLines(stdinText)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) continue;
    const [, localSha, remoteRef] = parts;
    // The *remote* branch name is what CI will see as the PR head, whatever
    // the local ref was (HEAD, a sha, or a different branch name).
    if (localSha === ZERO_SHA || !remoteRef.startsWith("refs/heads/")) continue; // deletion or tag
    const branch = remoteRef.slice("refs/heads/".length);
    if (branch === baseBranch) continue; // reports are per feature branch; the base is guarded by PRs + rules
    // Git blocks a push on any non-zero exit, so a check that can't run skips
    // the branch. This hook runs the repo's own gate, so a report from another
    // gate version is a verdict here.
    const check = checkForHook(root, { branch, rev: localSha }, true);
    if ("skipped" in check) {
      process.stderr.write(`ownership gate: skipped (${check.skipped})\n`);
      continue;
    }
    if (check.passed) continue;
    const label = check.mode === "required" ? "blocked" : "warning";
    process.stderr.write(`\nOwnership gate ${label} for '${branch}':\n- ${check.problems.join("\n- ")}\n`);
    failed ||= check.mode === "required";
  }
  if (failed) process.stderr.write("\n(Bypassing with --no-verify only delays this: CI runs the same check.)\n\n");
  return failed ? 1 : 0;
}

/** The hook pins the exact gate.mjs it was installed for. If a later pull or
 *  checkout changes that file, the hook refuses to run it (code you never
 *  trusted) and says how to re-trust. It executes the very bytes it hashed
 *  (as a data: URL module, which can import only node: built-ins), so nothing
 *  next to gate.mjs can be loaded instead. */
const PRE_PUSH_HOOK = (pin: string) => `#!/bin/sh
# comprende ownership gate (installed by gate.mjs install-hooks)
# pinned-sha256: ${pin}
root="$(git rev-parse --show-toplevel)" || exit 0
gate="$root/${GATE_REL}"
[ -f "$gate" ] || exit 0
command -v node >/dev/null 2>&1 || { echo "ownership gate: node not found, skipping" >&2; exit 0; }
exec env -u NODE_OPTIONS -u NODE_PATH node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const [gate, pin, ...rest] = process.argv.slice(1);
const code = readFileSync(gate);
if (createHash("sha256").update(code).digest("hex") !== pin) {
  process.stderr.write("ownership gate: ${GATE_REL} changed since this hook was installed, so it was not run. If you trust the new version: node ${GATE_REL} install-hooks\\n");
  process.exit(0);
}
process.argv = [process.argv[0], gate, "pre-push", ...rest];
await import("data:text/javascript;base64," + code.toString("base64"));
' "$gate" "${pin}" "$@"
`;

/** Install (or re-pin) the pre-push hook for the repo's current gate.mjs.
 *  auto=true (the plugin's SessionStart) only ever writes to this repo's own
 *  .git/hooks — never to a custom core.hooksPath, which is often a folder
 *  shared by every repo on the machine. */
export function installHooks(repo?: string | null, auto = false): string[] {
  const root = repoRoot(repo);
  const gateFile = join(root, GATE_REL);
  if (isSymlink(gateFile) || !isFile(gateFile))
    return [`SKIPPED pre-push hook: ${GATE_REL} is missing or not a regular file.`];
  const pin = createHash("sha256").update(readFileSync(gateFile)).digest("hex");
  let hooksDir = git(root, ["rev-parse", "--git-path", "hooks"]).trim();
  if (!isAbsolute(hooksDir)) hooksDir = join(root, hooksDir);
  const manualLine = `node "$(git rev-parse --show-toplevel)/${GATE_REL}" pre-push "$@" || exit 1`;
  const configured = git(root, ["config", "--get", "core.hooksPath"], { check: false }).trim();
  if (configured) {
    const expanded = configured.replace(/^~(?=$|[/\\])/, homedir());
    let custom = resolve(isAbsolute(expanded) ? expanded : join(root, expanded));
    try {
      custom = realpathSync(custom); // a symlink inside the repo can point at a shared folder
    } catch {
      /* doesn't exist yet: it will be created where it says */
    }
    if (auto) {
      return [
        `SKIPPED pre-push hook: core.hooksPath is set (${configured}), so it wasn't added automatically. Run \`node ${GATE_REL} install-hooks\` to add it there.`,
      ];
    }
    const rel = relative(realpathSync(root), custom);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return [
        `SKIPPED pre-push hook: core.hooksPath (${configured}) is outside this repo and may be shared by other repos. Add this line to its pre-push hook yourself: ${manualLine}`,
      ];
    }
    hooksDir = custom;
  }
  const hook = join(hooksDir, "pre-push");
  if (isSymlink(hook)) return [`SKIPPED pre-push hook: ${hook} is a symlink.`];
  let verb = "installed";
  if (existsSync(hook)) {
    const text = readFileSync(hook, "utf8");
    if (!text.includes("comprende ownership gate"))
      return [`SKIPPED pre-push hook: ${hook} already exists. Add this line to it: ${manualLine}`];
    if (text.includes(`pinned-sha256: ${pin}`)) return [`pre-push hook already installed (${hook})`];
    verb = "re-pinned";
  }
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hook, PRE_PUSH_HOOK(pin), "utf8");
  chmodSync(hook, 0o755);
  return [`${verb} pre-push hook (${hook}) for gate.mjs sha256 ${pin.slice(0, 12)}`];
}
