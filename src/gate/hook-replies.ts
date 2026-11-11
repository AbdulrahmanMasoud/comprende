// What a hook prints and how it exits, when an agent adapter doesn't format its own
// replies (agents/types.ts): the defaults every tool so far accepts.

import type { Agent, Decision, HookReply } from "./agents/index.js";

/** Exit 0 with nothing printed: every tool reads it as "allow". Nothing at all,
 *  because Cursor blocks a command when a hook's stdout isn't JSON. */
export const SILENT_ALLOW: HookReply = { stdout: "", stderr: "", exitCode: 0 };

/** The reply for `decision`: the adapter's, or silent exit 0 to allow and exit 2
 *  with the reason on stderr to block. */
export function decisionReply(agent: Agent, decision: Decision): HookReply {
  if (agent.formatDecision) return agent.formatDecision(decision);
  return decision.allow ? SILENT_ALLOW : { stdout: "", stderr: `${decision.reason}\n`, exitCode: 2 };
}

/** The session-start stdout that adds `lines` to the agent's context: the
 *  adapter's, or Claude Code's hookSpecificOutput.additionalContext, which Cursor
 *  accepts too. */
export function sessionContextReply(agent: Agent | null, lines: readonly string[]): string {
  if (agent?.formatSessionContext) return agent.formatSessionContext(lines);
  return JSON.stringify(
    lines.length ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join(" ") } } : {},
  );
}
