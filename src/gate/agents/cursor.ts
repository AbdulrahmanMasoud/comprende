// Cursor: its own hooks and the Claude Code hook commands it also runs (the repo's
// .claude/settings.json and installed Claude Code plugins) get the same payload:
// the shell tool is "Shell", cwd is "", and the workspace is in workspace_roots.
// https://cursor.com/docs/hooks, https://cursor.com/docs/reference/third-party-hooks

import { isRecord } from "../../util.js";
import { readClaudeFormat } from "./claude-format.js";
import { CLAUDE_SETTINGS } from "./claude-settings.js";
import { CURSOR_HOOKS } from "./cursor-hooks.js";
import type { Agent, HookEnv } from "./types.js";

/** The repo a Cursor hook is for: the payload's cwd, else its one workspace root,
 *  else Cursor's project variables. Null (step aside) when it can't tell: Cursor
 *  runs a plugin's hooks from the plugin's folder, so the process's own folder
 *  says nothing, and with several roots the command may run in any of them.
 *  On Windows Cursor sends roots as "/c:/Users/…", so the slash before the drive
 *  goes (https://forum.cursor.com/t/154608; not tested on Windows here). */
export function cursorProjectDir(payload: unknown, env: HookEnv, platform: string = process.platform): string | null {
  const cwd = readClaudeFormat(payload).cwd;
  if (cwd) return cwd;
  const roots = (isRecord(payload) && Array.isArray(payload.workspace_roots) ? payload.workspace_roots : []).filter(
    (r): r is string => typeof r === "string" && r !== "",
  );
  if (roots.length > 1) return null;
  if (roots.length === 1)
    return platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(roots[0]) ? roots[0].slice(1) : roots[0];
  return env.CURSOR_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || null;
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
  projectDir: (payload, env) => cursorProjectDir(payload, env),

  names: { assistant: "Cursor", app: "Cursor" },

  // Cursor may be running the Claude Code plugin it imported, so name both. Its
  // own copy is a clone in its local plugins folder until it's in Cursor's
  // marketplace (docs/agents.md, "Install steps for a Cursor user").
  pluginUpdateHint:
    "`/plugin marketplace update comprende` in Claude Code if it's installed there, or, for Cursor's own copy, `git -C ~/.cursor/plugins/local/comprende pull` then Developer: Reload Window",

  // Cursor runs sessionStart once per chat, not again on --resume.
  eventId: (payload, event) => {
    const { toolUseId, sessionId } = readClaudeFormat(payload);
    return event === "shell" ? toolUseId : sessionId;
  },

  // Its own file first: when both run the gate, the run from .claude/settings.json
  // steps aside. Cursor runs .claude/settings.json only while Third-Party Imports
  // is on, which a person or an admin can turn off (and Enterprise accounts start
  // with it off), so a plugin can't step aside for it: they claim the event instead.
  projectHookFiles: [
    { file: CURSOR_HOOKS, alwaysRuns: true },
    { file: CLAUDE_SETTINGS, alwaysRuns: false },
  ],
};
