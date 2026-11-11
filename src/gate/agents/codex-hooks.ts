// The repo's .codex/hooks.json as a project hook file: the gate's shell hook and
// session start, which install adds for teammates on Codex. Codex runs them once the
// project and the hooks are trusted, and the trust holds across gate and plugin
// upgrades, since the commands don't change. That's why the session start is here:
// after a plugin update Codex skips the plugin's hooks without a word, and this one
// still tells the agent so (docs/agents.md, "Codex: the design"). Codex runs hooks in
// the session's folder, which may be a subfolder, so the commands find the repo's
// root with git. Codex runs them with the user's $SHELL, or PowerShell on Windows:
// `$(…)` works in sh, bash, zsh, fish 3.4+ and PowerShell. In another shell (tcsh,
// nu), or without git or node, they fail with an exit code other than 2, so they
// fail open. https://learn.chatgpt.com/docs/hooks

import { GATE_REL } from "../shared.js";
import { claudeFormatHookFile } from "./claude-format-hooks.js";
import { compactHooksJson } from "./compact-hooks-json.js";

const GATE = `node "$(git rev-parse --show-toplevel)/${GATE_REL}"`;

export const CODEX_HOOKS = claudeFormatHookFile({
  path: ".codex/hooks.json",
  agentFlag: "codex",
  feature: "codex-hooks",
  label: "Codex hooks",
  tool: "Codex",
  byHand:
    "add the hooks by hand: https://github.com/AbdulrahmanMasoud/comprende/blob/main/docs/teams.md#add-the-codex-hook-by-hand",
  keeps: "hooks",
  shellCommand: `${GATE} agent-hook --agent codex`,
  sessionStartCommand: `${GATE} session-start --from-repo --agent codex`,
  format: compactHooksJson,
});
