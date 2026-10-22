// The hook entry points: Claude Code's PreToolUse and SessionStart, and git's pre-push,
// plus installing the pinned pre-push hook.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { verify } from "./commands.js";
import { loadConfig } from "./config.js";
import { MAX_CONFIG_BYTES, exists, isFile, isSymlink, lstat, readSmall } from "./files.js";
import { git, repoRoot, resolveBase } from "./git.js";
import { isPushCommand } from "./push-detect.js";
import { uncommittedReport } from "./report.js";
import { CONFIG_PATH, GATE_REL, GateError, SELF, ZERO_SHA, splitLines } from "./shared.js";

function projectHasGateHook(root: string): boolean {
  try {
    const settings = JSON.parse(readSmall(join(root, ".claude", "settings.json"), MAX_CONFIG_BYTES));
    const groups = settings?.hooks?.PreToolUse ?? [];
    return groups.some((g: { hooks?: { command?: string }[] }) =>
      (g.hooks ?? []).some((h) => (h.command ?? "").includes("gate.mjs") && (h.command ?? "").includes("claude-hook")),
    );
  } catch {
    return false;
  }
}

/** PreToolUse hook for Claude Code. Exit 2 blocks the call and shows stderr to
 *  Claude. It checks the current branch; pushes of other branches are checked
 *  by the pre-push hook and CI. Outside a repo with the gate installed, or on
 *  an unexpected crash, it allows the call: this hook is a reminder; CI is the
 *  lock. fromPlugin: stays out of the way when the repo already registers the
 *  same hook, so the check never runs twice. The plugin never executes code
 *  from the repo it's looking at; it applies its own logic to the repo's data. */
export function claudeHook(stdinText: string, fromPlugin = false): number {
  let root: string;
  try {
    const payload = JSON.parse(stdinText || "{}");
    const command = String(payload?.tool_input?.command ?? "");
    if ((payload?.tool_name ?? "Bash") !== "Bash" || !isPushCommand(command)) return 0;
    root = repoRoot(payload?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (!lstat(join(root, CONFIG_PATH))) return 0;
    if (fromPlugin && projectHasGateHook(root)) return 0;
  } catch {
    return 0;
  }
  let passed: boolean, problems: string[], mode: string;
  try {
    [passed, problems, mode] = verify(root);
  } catch (e) {
    if (!(e instanceof GateError)) return 0;
    [passed, problems, mode] = [false, [e.message], "required"]; // e.g. a broken report
  }
  if (passed || mode !== "required") return 0;
  // The hook runs before the command, so `git commit … && git push` is checked
  // against the old HEAD. Say so when the fix is just a separate commit.
  const pending = uncommittedReport(root);
  if (pending) {
    process.stderr.write(
      `Blocked by the ownership gate: the report ${pending} is saved but not committed. Commit it first, then push as a separate command. ` +
        "This hook checks the branch before a command runs, so a push in the same command as the commit is blocked too.\n",
    );
    return 2;
  }
  process.stderr.write("Blocked by the ownership gate:\n- " + problems.join("\n- ") + "\n");
  return 2;
}

const MIN_NODE = 20;

// hooks/hooks.json carries the same note for a missing or unusable node.
const NODE_NOTE = "Tell the user in one line that Comprende needs Node.js 20 or newer (install it from https://nodejs.org), then a restart of Claude Code.";

// Every session, so explanations don't depend on the request sounding like a
// wish to learn. Fixed text on purpose: nothing read from the repo goes into it.
export const ALWAYS_ON =
  "Comprende is installed. Whenever you write or change code in this session, follow the comprende skill: " +
  "explain only what's new, non-obvious, risky or a real decision, briefly, in the user's language and dialect.";

/** SessionStart hook (plugin). Never throws — a session must always start. */
export function sessionStart(stdinText: string): Record<string, unknown> {
  const lines: string[] = [];
  const node = process.versions.node;
  if (Number.parseInt(node, 10) < MIN_NODE) lines.push(`Comprende is running on Node.js ${node}, which is too old. ${NODE_NOTE}`);
  if (process.env.COMPRENDE_QUIET !== "1") lines.push(ALWAYS_ON);
  lines.push(...gateContext(stdinText));
  return lines.length ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join(" ") } } : {};
}

/** In a repo that uses the gate: install the local pre-push hook if this clone
 *  lacks it, and tell Claude the repo is gated so the ownership-check protocol
 *  is followed. Elsewhere: nothing. */
function gateContext(stdinText: string): string[] {
  try {
    const payload = JSON.parse(stdinText || "{}");
    const root = repoRoot(payload?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
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
      if (!SELF || !readFileSync(repoGate).equals(readFileSync(SELF))) {
        lines.push(`This repo's ${GATE_REL} differs from the plugin's copy, so the local pre-push hook was NOT installed automatically. If the user trusts this repo, they can run \`node ${GATE_REL} install-hooks\`; mention this in one line.`);
      } else {
        const result = installHooks(root, true)[0];
        if (result.startsWith("installed") || result.startsWith("re-pinned")) {
          lines.push("The local pre-push git hook was just installed in this clone; mention it to the user in one line (set OWNERSHIP_GATE_NO_AUTO_HOOK=1 to opt out).");
        } else if (result.startsWith("SKIPPED")) lines.push("The gate's pre-push hook wasn't added: " + result);
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
    process.stderr.write(`\nOwnership gate ${label} for '${branch}':\n- ` + problems.join("\n- ") + "\n");
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
  if (isSymlink(gateFile) || !isFile(gateFile)) return [`SKIPPED pre-push hook: ${GATE_REL} is missing or not a regular file.`];
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
      return [`SKIPPED pre-push hook: core.hooksPath is set (${configured}), so it wasn't added automatically. Run \`node ${GATE_REL} install-hooks\` to add it there.`];
    }
    const rel = relative(realpathSync(root), custom);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
      return [`SKIPPED pre-push hook: core.hooksPath (${configured}) is outside this repo and may be shared by other repos. Add this line to its pre-push hook yourself: ${manualLine}`];
    }
    hooksDir = custom;
  }
  const hook = join(hooksDir, "pre-push");
  if (isSymlink(hook)) return [`SKIPPED pre-push hook: ${hook} is a symlink.`];
  let verb = "installed";
  if (exists(hook)) {
    const text = readFileSync(hook, "utf8");
    if (!text.includes("comprende ownership gate")) return [`SKIPPED pre-push hook: ${hook} already exists. Add this line to it: ${manualLine}`];
    if (text.includes(`pinned-sha256: ${pin}`)) return [`pre-push hook already installed (${hook})`];
    verb = "re-pinned";
  }
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hook, PRE_PUSH_HOOK(pin), "utf8");
  chmodSync(hook, 0o755);
  return [`${verb} pre-push hook (${hook}) for gate.mjs sha256 ${pin.slice(0, 12)}`];
}
