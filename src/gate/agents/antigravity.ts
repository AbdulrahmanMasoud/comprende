// Antigravity (Google): its hooks get a camelCase payload of its own, with `toolCall`
// for a tool event, and any non-zero exit or non-JSON stdout blocks the command. So
// this adapter formats both replies itself: a deny is JSON on exit 0, and session
// context is an injected system message. The plugin's hooks.json passes
// --agent antigravity. docs/agents.md, "Antigravity: what we found".
// https://antigravity.google/docs/hooks/

import { isAbsolute, resolve } from "node:path";
import { isRecord } from "../../util.js";
import { SILENT_ALLOW } from "../hook-replies.js";
import type { Agent } from "./types.js";

/** What the adapter reads from an Antigravity payload, validated once. */
interface AntigravityPayload {
  /** toolCall.name, such as "run_command", or null outside a tool event. */
  readonly toolName: string | null;
  /** toolCall.args.CommandLine, or "" when there's none. */
  readonly command: string;
  /** toolCall.args.Cwd, the command's folder, made absolute against cwd; null when the
   *  agent set none, or it's relative with no absolute cwd to resolve it against. */
  readonly commandCwd: string | null;
  /** The payload's cwd, the workspace's folder (Step 0), when it's absolute. */
  readonly cwd: string | null;
  /** toolCall.id, the same for every hook on one call. The docs don't list it. */
  readonly toolCallId: string | null;
  readonly conversationId: string | null;
}

const nonEmptyString = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function readAntigravity(payload: unknown): AntigravityPayload {
  const p = isRecord(payload) ? payload : {};
  const call = isRecord(p.toolCall) ? p.toolCall : {};
  const args = isRecord(call.args) ? call.args : {};
  const given = nonEmptyString(p.cwd);
  const cwd = given && isAbsolute(given) ? given : null;
  const commandCwd = nonEmptyString(args.Cwd);
  return {
    toolName: nonEmptyString(call.name),
    command: typeof args.CommandLine === "string" ? args.CommandLine : "",
    // A relative Cwd is the command's folder seen from the workspace's: resolve it, and
    // without an absolute cwd, don't guess (a wrong repo would mean a deny that isn't a
    // verdict on this push).
    commandCwd: !commandCwd ? null : isAbsolute(commandCwd) ? commandCwd : cwd && resolve(cwd, commandCwd),
    cwd,
    toolCallId: nonEmptyString(call.id),
    conversationId: nonEmptyString(p.conversationId),
  };
}

export const antigravity: Agent = {
  id: "antigravity",

  // camelCase, which no other tool sends. Our own hook file passes --agent antigravity.
  // This is for the hooks Antigravity converts from the Claude Code plugin (`agy plugin
  // import claude`), which pass none: both copies then claim the same tool call.
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
  // enabled, hooks or not (tested). So the session start only says the hooks ran.
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
