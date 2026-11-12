// Antigravity (Google): its hooks get a camelCase payload of its own, with `toolCall`
// for a tool event, and any non-zero exit or non-JSON stdout blocks the command. So
// this adapter formats both replies itself: a deny is JSON on exit 0, and session
// context is an injected system message. The plugin's hooks.json passes
// --agent antigravity. docs/agents.md, "Antigravity: what we found".
// https://antigravity.google/docs/hooks/

import { isAbsolute } from "node:path";
import { isRecord } from "../../util.js";
import { SILENT_ALLOW } from "../hook-replies.js";
import type { Agent } from "./types.js";

/** What the adapter reads from an Antigravity payload, validated once. */
interface AntigravityPayload {
  /** toolCall.name, such as "run_command", or null outside a tool event. */
  readonly toolName: string | null;
  /** toolCall.args.CommandLine, or "" when there's none. */
  readonly command: string;
  /** toolCall.args.Cwd, the command's folder, when the agent set an absolute one. */
  readonly commandCwd: string | null;
  /** The payload's cwd: the workspace's folder (Step 0). */
  readonly cwd: string | null;
  /** toolCall.id, the same for every hook on one call. The docs don't list it. */
  readonly toolCallId: string | null;
  readonly conversationId: string | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function readAntigravity(payload: unknown): AntigravityPayload {
  const p = isRecord(payload) ? payload : {};
  const call = isRecord(p.toolCall) ? p.toolCall : {};
  const args = isRecord(call.args) ? call.args : {};
  const commandCwd = text(args.Cwd);
  return {
    toolName: text(call.name),
    command: typeof args.CommandLine === "string" ? args.CommandLine : "",
    commandCwd: commandCwd && isAbsolute(commandCwd) ? commandCwd : null,
    cwd: text(p.cwd),
    toolCallId: text(call.id),
    conversationId: text(p.conversationId),
  };
}

export const antigravity: Agent = {
  id: "antigravity",

  // camelCase, which no other tool sends. Our own hook file passes --agent antigravity;
  // this is for a hook that doesn't, such as one a user writes for the gate.
  detects: (payload) =>
    isRecord(payload) && typeof payload.conversationId === "string" && typeof payload.hookEventName === "string",

  shellCommand(payload) {
    const { toolName, command } = readAntigravity(payload);
    return toolName === "run_command" ? command : null;
  },

  // The command's own folder when the agent gave one, then the workspace's. Never the
  // process's folder: Antigravity runs plugin hooks in the plugin's.
  projectDir(payload) {
    const { commandCwd, cwd } = readAntigravity(payload);
    return commandCwd ?? cwd;
  },

  names: { assistant: "Antigravity", app: "Antigravity" },

  pluginUpdateHint: "`agy plugin install https://github.com/AbdulrahmanMasoud/comprende` again",

  // The plugin's rules/AGENTS.md is loaded as an always-on rule whenever the plugin is
  // enabled, hooks or not (tested), so the session start doesn't repeat that line.
  alwaysOnFromRule: true,

  // None: Antigravity runs a repo's .agents/hooks.json alongside the plugin's hooks, so
  // install doesn't write one (docs/agents.md, "Antigravity: the design").
  projectHookFiles: [],

  eventId(payload, event) {
    const { toolCallId, conversationId } = readAntigravity(payload);
    return event === "shell" ? toolCallId : conversationId;
  },

  // Antigravity blocks on a JSON deny on exit 0, and shows the reason. An allow is
  // nothing at all: {"decision": "allow"} means the same, and stdout that isn't
  // JSON would block (tested).
  formatDecision: (decision) =>
    decision.allow
      ? SILENT_ALLOW
      : { stdout: JSON.stringify({ decision: "deny", reason: decision.reason }), stderr: "", exitCode: 0 },

  // A system message: of the shapes Antigravity documents, the one the agent reads as
  // instructions, "injected by a SessionStart hook". A user message would read as the
  // user's own request (tested). No other field: a field it doesn't know fails the reply.
  // With nothing to say, `{}`, since the reply is read as JSON.
  formatSessionContext: (lines) =>
    JSON.stringify(lines.length ? { injectSteps: [{ systemMessage: { systemMessage: lines.join(" ") } }] } : {}),
};
