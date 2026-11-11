// The repo's .codex/hooks.json as a project hook file: the gate's shell hook, which
// install adds for teammates on Codex. Codex runs it once the project and the hook
// are trusted, and the trust holds across gate upgrades, since the command doesn't
// change. Codex runs hooks in the session's folder, which may be a subfolder, so the
// command finds the repo's root with git. Codex runs it with the user's $SHELL, or
// PowerShell on Windows: `$(…)` works in sh, bash, zsh, fish 3.4+ and PowerShell. In
// another shell (tcsh, nu), or without git or node, it fails with an exit code
// other than 2, so it fails open. Only the shell hook: a session start here would
// repeat the plugin's (docs/agents.md, "Codex: the design"). https://learn.chatgpt.com/docs/hooks

import { GATE_REL } from "../shared.js";
import { claudeFormatHookFile } from "./claude-format-hooks.js";
import { compactHooksJson } from "./compact-hooks-json.js";

const HOOK_COMMAND = `node "$(git rev-parse --show-toplevel)/${GATE_REL}" agent-hook --agent codex`;

export const CODEX_HOOKS = claudeFormatHookFile({
  path: ".codex/hooks.json",
  agentFlag: "codex",
  feature: "codex-hooks",
  label: "Codex hook",
  tool: "Codex",
  byHand:
    "add the hook by hand: https://github.com/AbdulrahmanMasoud/comprende/blob/main/docs/teams.md#add-the-codex-hook-by-hand",
  keeps: "hooks",
  command: HOOK_COMMAND,
  format: compactHooksJson,
});
