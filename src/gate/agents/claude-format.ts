// The Claude Code hook payload, which Cursor also sends to Claude-format hooks:
// the tool's name, the shell command and the working folder, validated here so
// the adapters only see typed values.

import { isRecord } from "../../util.js";

export interface ClaudeFormatPayload {
  /** The tool about to run, or null when the payload doesn't say. */
  readonly toolName: string | null;
  /** tool_input.command, or "" when there's none. */
  readonly command: string;
  /** The working folder, or null when it's missing or empty (Cursor always sends ""). */
  readonly cwd: string | null;
}

export function readClaudeFormat(payload: unknown): ClaudeFormatPayload {
  const p = isRecord(payload) ? payload : {};
  const input = isRecord(p.tool_input) ? p.tool_input : {};
  return {
    toolName: p.tool_name === undefined || p.tool_name === null ? null : String(p.tool_name),
    command: String(input.command ?? ""),
    cwd: typeof p.cwd === "string" && p.cwd ? p.cwd : null,
  };
}
