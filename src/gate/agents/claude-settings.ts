// The repo's .claude/settings.json as a project hook file: the PreToolUse hook that
// install merges in for teammates without the plugin. Claude Code runs it, and so
// does Cursor, which reads Claude Code's settings files.

import { GATE_REL } from "../shared.js";
import { claudeFormatHookFile } from "./claude-format-hooks.js";

// Without node, exit 0: any other non-2 code would still be shown as a hook error on every Bash call.
// It stays `claude-hook`, not `agent-hook`: the plugin's hook in Comprende 0.2.x
// steps aside only when the repo's settings call `claude-hook`, so a new name
// would make an older plugin run the check a second time.
const HOOK_COMMAND = `command -v node >/dev/null 2>&1 || exit 0; exec node "$CLAUDE_PROJECT_DIR/${GATE_REL}" claude-hook`;

const HOOK_BY_HAND =
  "add the hook by hand: https://github.com/AbdulrahmanMasoud/comprende/blob/main/docs/teams.md#add-the-claude-hook-by-hand";

export const CLAUDE_SETTINGS = claudeFormatHookFile({
  path: ".claude/settings.json",
  agentFlag: null,
  label: "Claude hook",
  tool: "Claude Code",
  byHand: HOOK_BY_HAND,
  keeps: "settings",
  shellCommand: HOOK_COMMAND,
  format: (settings) => `${JSON.stringify(settings, null, 2)}\n`,
});
