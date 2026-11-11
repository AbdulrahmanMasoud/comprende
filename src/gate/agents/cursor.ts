// Cursor: its own hooks and the Claude Code hook commands it also runs (the repo's
// .claude/settings.json and installed Claude Code plugins) get the same payload:
// the shell tool is "Shell", cwd is "", and the workspace is in workspace_roots.
// https://cursor.com/docs/hooks, https://cursor.com/docs/reference/third-party-hooks

import { isRecord } from "../../util.js";
import { readClaudeFormat } from "./claude-format.js";
import { CLAUDE_SETTINGS } from "./claude-settings.js";
import type { Agent } from "./types.js";

/** The first of workspace_roots. On Windows Cursor sends them as "/c:/Users/…"
 *  (reported on Cursor's forum, not tested here), so the slash before the drive goes. */
function firstWorkspaceRoot(payload: unknown): string | null {
  const roots = isRecord(payload) && Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
  const root = roots.find((r): r is string => typeof r === "string" && r !== "");
  if (!root) return null;
  return process.platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(root) ? root.slice(1) : root;
}

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

  // From the payload first: its workspace, since cwd is always "". Then Cursor's
  // project variables. Never the process's own folder: Cursor runs a plugin's
  // hooks from the plugin's folder, which may sit inside some other repo.
  projectDir: (payload, env) =>
    readClaudeFormat(payload).cwd ??
    firstWorkspaceRoot(payload) ??
    (env.CURSOR_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || null),

  names: { assistant: "Cursor", app: "Cursor" },

  pluginUpdateHint: "`agent plugin marketplace update comprende` in the Cursor CLI, or Customize → Plugins in the IDE",

  projectHookFiles: [CLAUDE_SETTINGS],
};
