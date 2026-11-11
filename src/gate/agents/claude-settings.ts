// The repo's .claude/settings.json as a project hook file: the PreToolUse hook that
// install merges in for teammates without the plugin. Claude Code runs it, and so
// does Cursor, which reads Claude Code's settings files.

import { isRecord } from "../../util.js";
import { GATE_REL } from "../shared.js";
import { isGateCommand } from "./gate-command.js";
import type { HookEvent, ProjectHookFile } from "./types.js";

// Without node, exit 0: any other non-2 code would still be shown as a hook error on every Bash call.
// It stays `claude-hook`, not `agent-hook`: the plugin's hook in Comprende 0.2.x
// steps aside only when the repo's settings call `claude-hook`, so a new name
// would make an older plugin run the check a second time.
const HOOK_COMMAND = `command -v node >/dev/null 2>&1 || exit 0; exec node "$CLAUDE_PROJECT_DIR/${GATE_REL}" claude-hook`;

const HOOK_BY_HAND =
  "add the hook by hand: https://github.com/AbdulrahmanMasoud/comprende/blob/main/docs/teams.md#add-the-claude-hook-by-hand";

const LABEL = "Claude hook";

/** Claude Code's name for each of the gate's events. */
const EVENT_KEY: Record<HookEvent, string> = { shell: "PreToolUse", sessionStart: "SessionStart" };

/** Does a list of Claude Code hook groups run the gate? Entries of a shape we
 *  don't know are skipped, not trusted. */
const listsGateHook = (groups: unknown[], event: HookEvent): boolean =>
  groups.some(
    (g) => isRecord(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isRecord(h) && isGateCommand(h.command, event)),
  );

export const CLAUDE_SETTINGS: ProjectHookFile = {
  path: ".claude/settings.json",
  agentFlag: null,

  runsGate(content, event) {
    let settings: unknown;
    try {
      settings = JSON.parse(content);
    } catch {
      return false;
    }
    const groups = isRecord(settings) && isRecord(settings.hooks) ? settings.hooks[EVENT_KEY[event]] : undefined;
    return Array.isArray(groups) && listsGateHook(groups, event);
  },

  withGateHook(existing, shownPath) {
    if (existing !== null && "unreadable" in existing) return { message: `SKIPPED ${LABEL}: ${existing.unreadable}` };
    let settings: Record<string, unknown> = {};
    if (existing !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing.text || "{}");
      } catch {
        return { message: `SKIPPED ${LABEL}: ${shownPath} is not valid JSON; ${HOOK_BY_HAND}` };
      }
      if (!isRecord(parsed)) return { message: `SKIPPED ${LABEL}: ${shownPath} is not a JSON object; ${HOOK_BY_HAND}` };
      settings = parsed;
    }
    // Never replace a value we don't understand: that would drop the user's settings.
    if (settings.hooks !== undefined && !isRecord(settings.hooks))
      return { message: `SKIPPED ${LABEL}: "hooks" in ${shownPath} is not an object; ${HOOK_BY_HAND}` };
    settings.hooks ??= {};
    const hooks = settings.hooks as Record<string, unknown>;
    if (hooks.PreToolUse !== undefined && !Array.isArray(hooks.PreToolUse))
      return { message: `SKIPPED ${LABEL}: "hooks.PreToolUse" in ${shownPath} is not a list; ${HOOK_BY_HAND}` };
    hooks.PreToolUse ??= [];
    const groups = hooks.PreToolUse as unknown[];
    if (listsGateHook(groups, "shell")) return { message: `${LABEL} already present (${shownPath})` };
    groups.push({ matcher: "Bash", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 60 }] } as never);
    return {
      content: `${JSON.stringify(settings, null, 2)}\n`,
      message: `merged a Claude Code PreToolUse hook into ${shownPath} (other settings kept)`,
    };
  },
};
