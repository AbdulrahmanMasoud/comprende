// install: turning the gate on for a repo. It writes the gate copy, the config,
// the CI workflow and each agent's repo-level hook file, adds the .gitignore and .gitattributes
// lines and the local pre-push hook, and sets up CODEOWNERS.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PROJECT_HOOK_FILES } from "./agents/index.js";
import { setUpCodeowners } from "./codeowners.js";
import { DEFAULT_CONFIG } from "./config.js";
import { atomicWrite, readExisting } from "./files.js";
import { repoRoot, resolveBase } from "./git.js";
import { type GateCopyDifference, gateCopyDifference, installHooks } from "./hooks.js";
import { addInstallLine, INSTALL_LINES } from "./install-lines.js";
import { REPO_PLATFORM } from "./platforms/index.js";
import { addProjectHook } from "./project-hooks.js";
import { CONFIG_PATH, GATE_REL, GateError, SELF } from "./shared.js";

/** What install says about an existing gate.mjs it wasn't asked to replace. */
const EXISTING_GATE_NOTE: Record<GateCopyDifference, string> = {
  none: "up to date",
  "repo-crlf": `differs only in its CRLF line endings (git's core.autocrlf): run \`git -c core.autocrlf=false checkout -- ${GATE_REL}\`, and the .gitattributes line keeps it byte for byte from then on`,
  // --upgrade would copy those CRLF line endings into the repo.
  "plugin-crlf":
    "matches, apart from this gate's own CRLF line endings (git's core.autocrlf): update the plugin instead of using --upgrade",
  content: "exists (pass --upgrade to replace)",
};

export function install(repo?: string | null, upgrade = false, owner?: string | null): string[] {
  const root = repoRoot(repo);
  const done: string[] = [];
  const target = join(root, GATE_REL);
  if (!SELF) throw new GateError("Can't locate this gate's own file to install it.");
  if (existsSync(target) && resolve(target) === resolve(SELF)) done.push(`${GATE_REL} is this file`);
  else if (existsSync(target) && !upgrade) {
    done.push(`${GATE_REL} ${EXISTING_GATE_NOTE[gateCopyDifference(readFileSync(target), readFileSync(SELF))]}`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(SELF, target);
    chmodSync(target, 0o755);
    done.push(`wrote ${GATE_REL}`);
  }

  const cfgPath = join(root, CONFIG_PATH);
  if (existsSync(cfgPath)) done.push(`${CONFIG_PATH} exists (kept)`);
  else {
    const cfg = { ...DEFAULT_CONFIG };
    try {
      const b = resolveBase(root, { base: "" }, null);
      cfg.base = b.includes("/") ? b.slice(b.indexOf("/") + 1) : b;
    } catch {
      cfg.base = "main";
    }
    atomicWrite(cfgPath, `${JSON.stringify({ ownership_check: cfg }, null, 2)}\n`);
    done.push(`wrote ${CONFIG_PATH} (base: ${cfg.base}, mode: required)`);
  }

  const ci = REPO_PLATFORM.ciConfig;
  const ciPath = join(root, ci.path);
  const { content, message } = ci.withGateJob(existsSync(ciPath) ? readExisting(ciPath) : null, ci.path);
  if (content !== undefined) atomicWrite(ciPath, content);
  done.push(message);

  for (const file of PROJECT_HOOK_FILES) done.push(addProjectHook(join(root, file.path), file));
  for (const { file, line } of INSTALL_LINES) done.push(addInstallLine(root, file, line));
  done.push(...installHooks(root));
  done.push(
    `NEXT, after this is merged: run \`node ${GATE_REL} protect\` (dry run, then --apply) to require the '${REPO_PLATFORM.checkName}' status on the default branch — without it CI only warns.`,
  );
  done.push(setUpCodeowners(root, owner));
  return done;
}
