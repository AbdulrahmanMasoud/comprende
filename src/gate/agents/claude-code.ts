// Claude Code: its PreToolUse and SessionStart payloads, its "Bash" shell tool, and
// the project-level hook in .claude/settings.json.
// https://code.claude.com/docs/en/hooks

import { readClaudeFormat } from "./claude-format.js";
import { CLAUDE_SETTINGS } from "./claude-settings.js";
import type { Agent } from "./types.js";

export const claudeCode: Agent = {
  id: "claude-code",

  // The fallback for the Claude-format command: its payloads carry no marker of
  // their own, and the tools that also run it are detected first (index.ts).
  detects: () => true,

  shellCommand(payload) {
    const { toolName, command } = readClaudeFormat(payload);
    return (toolName ?? "Bash") === "Bash" ? command : null;
  },

  projectDir: (payload, env) => readClaudeFormat(payload).cwd ?? (env.CLAUDE_PROJECT_DIR || null),

  projectHookFiles: [CLAUDE_SETTINGS],
};
