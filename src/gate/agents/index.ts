// The registry of agent adapters, the one step that picks the adapter for a hook
// run, and the core's default replies for adapters that don't format their own.

import { claudeCode } from "./claude-code.js";
import { cursor } from "./cursor.js";
import type { Agent, Decision, HookEnv, HookReply, ProjectHookFile } from "./types.js";

/** Every adapter, in detection order: a tool that also runs Claude Code's hook
 *  commands comes before Claude Code, which detects everything. */
export const AGENTS: readonly Agent[] = [cursor, claudeCode];

/** The adapter for this hook run: `--agent <id>` wins, then detection. Null for
 *  an unknown `--agent`: the hook then steps aside silently. */
export function resolveAgent(payload: unknown, env: HookEnv, requested?: string | null): Agent | null {
  if (requested) return AGENTS.find((a) => a.id === requested) ?? null;
  return AGENTS.find((a) => a.detects(payload, env)) ?? null;
}

/** Every repo-level hook file, once each, for install and for GATE_FILES. */
export const PROJECT_HOOK_FILES: readonly ProjectHookFile[] = [...new Set(AGENTS.flatMap((a) => a.projectHookFiles))];

/** Exit 0 with nothing printed: what every tool reads as "allow". */
export const SILENT_ALLOW: HookReply = { stdout: "", stderr: "", exitCode: 0 };

/** The reply for `decision`, in the adapter's format or the core's default:
 *  silent exit 0 to allow, exit 2 with the reason on stderr to block. */
export function decisionReply(agent: Agent, decision: Decision): HookReply {
  if (agent.formatDecision) return agent.formatDecision(decision);
  return decision.allow ? SILENT_ALLOW : { stdout: "", stderr: `${decision.reason}\n`, exitCode: 2 };
}

/** The session-start stdout that adds `lines` to the agent's context, in the
 *  adapter's format or the core's default (Claude Code's, which Cursor accepts). */
export function sessionContextReply(agent: Agent | null, lines: readonly string[]): string {
  if (agent?.formatSessionContext) return agent.formatSessionContext(lines);
  return JSON.stringify(
    lines.length ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join(" ") } } : {},
  );
}

export type { Agent, AgentId, Decision, HookEnv, HookReply, ProjectHookFile } from "./types.js";
