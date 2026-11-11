// The registry of agent adapters, and the one step that picks the adapter for a
// hook run.

import { claudeCode } from "./claude-code.js";
import { cursor } from "./cursor.js";
import type { Agent, HookEnv, ProjectHookFile } from "./types.js";

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

export type { Agent, AgentId, Decision, HookEnv, HookReply, ProjectHookFile } from "./types.js";
