// Cursor: it runs Claude Code's hook commands (the repo's .claude/settings.json and
// installed Claude Code plugins), but sends its own payload: the shell tool is
// "Shell", cwd is "", and the project comes from CURSOR_PROJECT_DIR. Input only for
// now; Cursor's own hook file, .cursor/hooks.json, comes with Cursor support (#2).
// https://cursor.com/docs/reference/third-party-hooks

import { CLAUDE_SETTINGS } from "./claude-settings.js";
import type { Agent } from "./types.js";

/** The fields this adapter reads. The payload is unvalidated JSON, so each one is unknown. */
type Payload =
  | { cursor_version?: unknown; tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown }
  | null
  | undefined;

export const cursor: Agent = {
  id: "cursor",

  // Only Cursor puts cursor_version in a payload. Not the environment: Claude Code
  // started from Cursor's terminal may inherit Cursor's variables.
  detects: (payload) => typeof (payload as Payload)?.cursor_version === "string",

  shellCommand(payload) {
    const p = payload as Payload;
    if ((p?.tool_name ?? "Shell") !== "Shell") return null;
    return String(p?.tool_input?.command ?? "");
  },

  // Cursor sets CLAUDE_PROJECT_DIR to the same path, for Claude-format hooks.
  projectDir(payload, env) {
    const cwd = (payload as Payload)?.cwd;
    return cwd ? String(cwd) : env.CURSOR_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || null;
  },

  projectHookFiles: [CLAUDE_SETTINGS],
};
