// The repo's .claude/settings.json as a project hook file: the PreToolUse hook that
// install merges in for teammates without the plugin. Claude Code runs it, and so
// does Cursor, which reads Claude Code's settings files.

import { isRecord } from "../../util.js";
import { GATE_REL } from "../shared.js";
import type { ProjectHookFile } from "./types.js";

// Without node, exit 0: any other non-2 code would still be shown as a hook error on every Bash call.
const HOOK_COMMAND = `command -v node >/dev/null 2>&1 || exit 0; exec node "$CLAUDE_PROJECT_DIR/${GATE_REL}" claude-hook`;

const HOOK_BY_HAND =
  "add the hook by hand: https://github.com/AbdulrahmanMasoud/comprende/blob/main/docs/teams.md#add-the-claude-hook-by-hand";

const LABEL = "Claude hook";

type HookGroup = { hooks?: { command?: unknown }[] } | null | undefined;

/** A command that runs this gate's PreToolUse entry point, under either name. */
const isGateHookCommand = (command: unknown): boolean =>
  typeof command === "string" &&
  command.includes("gate.mjs") &&
  (command.includes("claude-hook") || command.includes("agent-hook"));

const listsGateHook = (groups: HookGroup[]): boolean =>
  groups.some((g) => (g?.hooks ?? []).some((h) => isGateHookCommand(h?.command)));

export const CLAUDE_SETTINGS: ProjectHookFile = {
  path: ".claude/settings.json",
  label: LABEL,

  runsGate(content) {
    try {
      const groups = JSON.parse(content)?.hooks?.PreToolUse ?? [];
      return Array.isArray(groups) && listsGateHook(groups);
    } catch {
      return false;
    }
  },

  withGateHook(existing, shownPath) {
    let settings: Record<string, unknown> = {};
    if (existing !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing || "{}");
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
    const groups = hooks.PreToolUse as HookGroup[];
    if (listsGateHook(groups)) return { message: `${LABEL} already present (${shownPath})` };
    groups.push({ matcher: "Bash", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 60 }] } as never);
    return {
      content: `${JSON.stringify(settings, null, 2)}\n`,
      message: `merged a Claude Code PreToolUse hook into ${shownPath} (other settings kept)`,
    };
  },
};
