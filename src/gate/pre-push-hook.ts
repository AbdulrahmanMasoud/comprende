// git's pre-push hook: the check it runs on each pushed branch, and installing it,
// pinned to the exact bytes of the repo's gate.mjs.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isFile, isSymlink } from "../util.js";
import { checkForHook } from "./commands.js";
import { loadConfig } from "./config.js";
import { git, repoRoot, resolveBase } from "./git.js";
import { GATE_REL, splitLines, ZERO_SHA } from "./shared.js";

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
