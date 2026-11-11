// Claude Code: its PreToolUse and SessionStart payloads, its "Bash" shell tool, and
// the project-level hook in .claude/settings.json.
// https://code.claude.com/docs/en/hooks

import { CLAUDE_SETTINGS } from "./claude-settings.js";
import type { Agent } from "./types.js";

/** The fields this adapter reads. The payload is unvalidated JSON, so each one is unknown. */
type Payload = { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown } | null | undefined;

export const claudeCode: Agent = {
  id: "claude-code",

  // The fallback for the Claude-format command: its payloads carry no marker of
  // their own, and the tools that also run it are detected first (index.ts).
  detects: () => true,

  shellCommand(payload) {
    const p = payload as Payload;
    if ((p?.tool_name ?? "Bash") !== "Bash") return null;
    return String(p?.tool_input?.command ?? "");
  },

  projectDir(payload, env) {
    const cwd = (payload as Payload)?.cwd;
    return cwd ? String(cwd) : env.CLAUDE_PROJECT_DIR || null;
  },

  projectHookFiles: [CLAUDE_SETTINGS],
};
