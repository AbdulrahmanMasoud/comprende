// The registry of agent adapters, and the one step that picks the adapter for a
// hook run.

import { claudeCode } from "./claude-code.js";
import { cursor } from "./cursor.js";
import type { Agent, HookEnv, HookEvent, ProjectHookFile } from "./types.js";

/** Every adapter, in detection order: a tool that also runs Claude Code's hook
 *  commands comes before Claude Code, which detects everything. */
export const AGENTS: readonly Agent[] = [cursor, claudeCode];

/** The adapter for this hook run: `--agent <id>` wins, then detection. Null for
 *  an unknown `--agent`: the hook then steps aside silently. */
export function resolveAgent(payload: unknown, env: HookEnv, requested?: string | null): Agent | null {
  if (requested) return AGENTS.find((a) => a.id === requested) ?? null;
  return AGENTS.find((a) => a.detects(payload, env)) ?? null;
}

/** How messages name the tool when no adapter is known: CI, the git hook, or a
 *  payload no adapter reads. */
export const UNKNOWN_AGENT_NAMES: Agent["names"] = { assistant: "your AI assistant", app: "your AI tool" };

/** Every repo-level hook file, once each, for install and for GATE_FILES. */
export const PROJECT_HOOK_FILES: readonly ProjectHookFile[] = [...new Set(AGENTS.flatMap((a) => a.projectHookFiles))];

export type { Agent, AgentId, Decision, HookEnv, HookEvent, HookReply, ProjectHookFile } from "./types.js";

/** Should a run of the gate's hook for `event` step aside, so that only one copy
 *  checks? A plugin's run steps aside when any of the repo's hook files runs the
 *  gate. A run from one of those files steps aside when a more specific one does,
 *  such as .claude/settings.json in Cursor once .cursor/hooks.json runs the gate.
 *  `runsGate` reads a file from the repo; `requested` is the run's --agent. */
export function stepsAside(
  agent: Agent,
  event: HookEvent,
  fromPlugin: boolean,
  requested: string | null,
  runsGate: (file: ProjectHookFile, event: HookEvent) => boolean,
): boolean {
  const files = agent.projectHookFiles;
  if (fromPlugin) return files.some((f) => runsGate(f, event));
  const source = files.findIndex((f) => f.agentFlag === requested);
  return source > 0 && files.slice(0, source).some((f) => runsGate(f, event));
}
