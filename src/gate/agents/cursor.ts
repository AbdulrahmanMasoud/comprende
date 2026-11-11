// Cursor: it runs Claude Code's hook commands (the repo's .claude/settings.json and
// installed Claude Code plugins), but sends its own payload: the shell tool is
// "Shell", cwd is "", and the project comes from its environment. Input only for
// now; Cursor's own hook file, .cursor/hooks.json, comes with Cursor support (#2).
// https://cursor.com/docs/reference/third-party-hooks

import { isRecord } from "../../util.js";
import { readClaudeFormat } from "./claude-format.js";
import { CLAUDE_SETTINGS } from "./claude-settings.js";
import type { Agent } from "./types.js";

export const cursor: Agent = {
  id: "cursor",

  // Only Cursor sends cursor_version, or calls its shell tool "Shell". Not the
  // environment: Claude Code started from Cursor's terminal may inherit Cursor's variables.
  detects: (payload) =>
    isRecord(payload) && (typeof payload.cursor_version === "string" || payload.tool_name === "Shell"),

  shellCommand(payload) {
    const { toolName, command } = readClaudeFormat(payload);
    return (toolName ?? "Shell") === "Shell" ? command : null;
  },

  // Cursor sets both variables to the same path. CLAUDE_PROJECT_DIR comes first,
  // as it did before this adapter existed.
  projectDir: (payload, env) =>
    readClaudeFormat(payload).cwd ?? (env.CLAUDE_PROJECT_DIR || env.CURSOR_PROJECT_DIR || null),

  projectHookFiles: [CLAUDE_SETTINGS],
};
