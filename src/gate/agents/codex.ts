// Codex: its hooks get Claude Code's payload, plus Codex's own `turn_id` and
// `model`. The shell tool is "Bash", and exit 2 with stderr blocks, so the core's
// default replies work. Codex also runs a Claude Code plugin's hooks/hooks.json
// when it installs one from .claude-plugin/. docs/agents.md, "Codex: what we found".
// https://learn.chatgpt.com/docs/hooks

import { isRecord } from "../../util.js";
import { readClaudeFormat } from "./claude-format.js";
import { CODEX_HOOKS } from "./codex-hooks.js";
import type { Agent } from "./types.js";

export const codex: Agent = {
  id: "codex",

  // Only Codex sends `turn_id`, on a tool call, which is where detection matters:
  // read as Claude Code's, a push would step aside for .claude/settings.json.
  // Not `model`: Claude Code's session start sends it too. So a Codex session
  // start without --agent is read as Claude Code's: its notes name Claude Code
  // and give Claude Code's update hint, until Codex's own hooks pass --agent codex.
  detects: (payload) => isRecord(payload) && typeof payload.turn_id === "string",

  shellCommand(payload) {
    const { toolName, command } = readClaudeFormat(payload);
    return toolName === "Bash" ? command : null;
  },

  // The payload's cwd is the command's own folder. Without one, step aside rather
  // than guess: the hook process runs in the session's folder, which may differ.
  projectDir: (payload) => readClaudeFormat(payload).cwd,

  names: { assistant: "Codex", app: "Codex" },

  // Codex skips a plugin's hooks after any change to its files, until they're
  // trusted again, so an update needs both steps.
  pluginUpdateHint: "`codex plugin marketplace upgrade comprende`, then trust Comprende's hooks again in `/hooks`",

  // A tool call's id, or the session's. With two plugin copies in one session (the
  // Codex plugin, and a Claude Code copy brought over by `/import`), both detect a
  // tool call as Codex's and claim it, so a push is checked once. A session start
  // has no turn_id, so that copy reads it as Claude Code's, claims nothing, and the
  // session lines come twice (docs/agents.md, "Codex: the design").
  eventId: (payload, event) => {
    const { toolUseId, sessionId } = readClaudeFormat(payload);
    return event === "shell" ? toolUseId : sessionId;
  },

  // Codex never runs .claude/settings.json or .cursor/hooks.json, so a plugin's
  // hook must not step aside for them. It runs .codex/hooks.json only once the
  // project and the hook are trusted, so it can't count on that one either: the
  // copies claim the tool call instead (hook-copies.ts).
  projectHookFiles: [{ file: CODEX_HOOKS, alwaysRuns: false }],
};
