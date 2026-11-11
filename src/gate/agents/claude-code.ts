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

  // Claude Code runs every hook from the project, so its own folder is a fair last guess.
  projectDir: (payload, env) => readClaudeFormat(payload).cwd ?? (env.CLAUDE_PROJECT_DIR || process.cwd()),

  names: { assistant: "Claude", app: "Claude Code" },

  pluginUpdateHint: "`/plugin marketplace update comprende`",

  projectHookFiles: [CLAUDE_SETTINGS],
};
