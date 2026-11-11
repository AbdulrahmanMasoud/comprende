// The hook entry points: the AI tools' PreToolUse and SessionStart, through their
// adapters (agents/), and git's pre-push, plus installing the pinned pre-push hook.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isFile, isSymlink, lstat } from "../util.js";
import { type Agent, type HookEnv, type HookReply, resolveAgent } from "./agents/index.js";
import { verify } from "./commands.js";
import { loadConfig } from "./config.js";
import { git, repoRoot, resolveBase } from "./git.js";
import { decisionReply, SILENT_ALLOW, sessionContextReply } from "./hook-replies.js";
import { projectHookRunsGate } from "./project-hooks.js";
import { isPushCommand } from "./push-detect.js";
import { uncommittedReport } from "./report.js";
import { CONFIG_PATH, GATE_ATTRIBUTES_LINE, GATE_REL, GateError, SELF, splitLines, ZERO_SHA } from "./shared.js";

/** The hook's payload and the adapter that reads it, or no adapter when stdin
 *  isn't JSON or `--agent` names an unknown tool. Never throws. */
function readHookInput(stdinText: string, requested: string | null): { payload: unknown; agent: Agent | null } {
  try {
    const payload: unknown = JSON.parse(stdinText || "{}");
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
 *  this hook is a reminder; CI is the lock. fromPlugin: stays out of the way when
 *  the repo's own hook file already runs the gate, so the check never runs twice.
 *  The plugin never executes code from the repo it's looking at; it applies its
 *  own logic to the repo's data. */
export function agentHook(stdinText: string, fromPlugin: boolean, requested: string | null): HookReply {
  const { payload, agent } = readHookInput(stdinText, requested);
  if (!agent) return SILENT_ALLOW;
  const env: HookEnv = process.env;
  const allow = decisionReply(agent, { allow: true });
  let root: string;
  try {
    const command = agent.shellCommand(payload);
    if (command === null || !isPushCommand(command)) return allow;
    const dir = agent.projectDir(payload, env);
    if (dir === null) return allow; // the tool didn't say which repo: step aside
    root = repoRoot(dir);
    if (!lstat(join(root, CONFIG_PATH))) return allow;
    if (fromPlugin && agent.projectHookFiles.some((f) => projectHookRunsGate(join(root, f.path), f))) return allow;
  } catch {
    return allow;
  }
  let passed: boolean, problems: string[], mode: string;
  try {
    [passed, problems, mode] = verify(root, null, null, "HEAD", [], agent.names.assistant);
  } catch (e) {
    if (!(e instanceof GateError)) return allow;
    [passed, problems, mode] = [false, [e.message], "required"]; // e.g. a broken report
  }
  if (passed || mode !== "required") return allow;
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
  return decisionReply(agent, { allow: false, reason: `Blocked by the ownership gate:\n- ${problems.join("\n- ")}` });
}

const MIN_NODE = 20;

// hooks/hooks.json carries the same note for a missing or unusable node.
const nodeNote = (app: string) =>
  `Tell the user in one line that Comprende needs Node.js 20 or newer (install it from https://nodejs.org), then a restart of ${app}.`;

// Every session, so explanations don't depend on the request sounding like a
// wish to learn. Fixed text on purpose: nothing read from the repo goes into it.
export const ALWAYS_ON =
  "Comprende is installed. Whenever you write or change code in this session, follow the comprende skill: " +
  "explain only what's new, non-obvious, risky or a real decision, briefly, in the user's language and dialect.";

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

/** SessionStart hook (plugin): the stdout that adds context for the agent, in the
 *  adapter's format. Never throws — a session must always start. */
export function sessionStart(stdinText: string, requested: string | null): string {
  const { payload, agent } = readHookInput(stdinText, requested);
  const lines: string[] = [];
  const node = process.versions.node;
  if (Number.parseInt(node, 10) < MIN_NODE)
    lines.push(
      `Comprende is running on Node.js ${node}, which is too old. ${nodeNote(agent?.names.app ?? "the AI tool")}`,
    );
  if (process.env.COMPRENDE_QUIET !== "1") lines.push(ALWAYS_ON);
  if (agent) lines.push(...gatedRepoContext(agent, payload));
  return sessionContextReply(agent, lines);
}

/** In a repo that uses the gate: install the local pre-push hook if this clone
 *  lacks it, and tell the agent the repo is gated so the ownership-check protocol
 *  is followed. Elsewhere: nothing. */
function gatedRepoContext(agent: Agent, payload: unknown): string[] {
  try {
    const dir = agent.projectDir(payload, process.env);
    if (dir === null) return [];
    const root = repoRoot(dir);
    if (!lstat(join(root, CONFIG_PATH))) return [];
    const cfg = loadConfig(root);
    if (cfg.mode === "off") return [];
    const lines = [
      `This repository uses the ownership gate (mode: ${cfg.mode}). For any code change, follow the comprende skill's ownership check (read references/ownership-check.md): brief in-flight questions, a final check before commit/PR, and a saved report.`,
    ];
    const repoGate = join(root, GATE_REL);
    if (process.env.OWNERSHIP_GATE_NO_AUTO_HOOK !== "1" && isFile(repoGate) && !isSymlink(repoGate)) {
      // The installed hook runs the repo's gate on every push. Only set that up
      // automatically when it's byte-identical to this (trusted) copy.
      const difference = SELF ? gateCopyDifference(readFileSync(repoGate), readFileSync(SELF)) : "content";
      if (difference !== "none") lines.push(untrustedGateNote(agent)[difference]);
      else {
        const result = installHooks(root, true)[0];
        if (result.startsWith("installed") || result.startsWith("re-pinned")) {
          lines.push(
            "The local pre-push git hook was just installed in this clone; mention it to the user in one line (set OWNERSHIP_GATE_NO_AUTO_HOOK=1 to opt out).",
          );
        } else if (result.startsWith("SKIPPED")) lines.push(`The gate's pre-push hook wasn't added: ${result}`);
      }
    }
    return lines;
  } catch {
    return [];
  }
}

export function prePush(stdinText: string, repo?: string | null): number {
  let root: string, baseBranch: string;
  try {
    root = repoRoot(repo);
    const b = resolveBase(root, loadConfig(root), null);
    baseBranch = b.includes("/") ? b.slice(b.indexOf("/") + 1) : b;
  } catch {
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
    let passed: boolean, problems: string[], mode: string;
    try {
      [passed, problems, mode] = verify(root, null, branch, localSha);
    } catch (e) {
      if (!(e instanceof GateError) && (e as NodeJS.ErrnoException).code) {
        process.stderr.write(`ownership gate: skipped (${(e as Error).message})\n`);
        continue;
      }
      [passed, problems, mode] = [false, [(e as Error).message], "required"];
    }
    if (passed) continue;
    const label = mode === "required" ? "blocked" : "warning";
    process.stderr.write(`\nOwnership gate ${label} for '${branch}':\n- ${problems.join("\n- ")}\n`);
    failed ||= mode === "required";
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
