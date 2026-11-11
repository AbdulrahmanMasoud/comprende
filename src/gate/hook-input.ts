// An AI tool's hook input: the JSON payload on stdin, and the adapter (agents/)
// that reads it. Both hook entry points, agent-hook.ts and session-start.ts, start here.

import { type Agent, resolveAgent } from "./agents/index.js";
import { withoutBom } from "./shared.js";

/** The hook's payload and the adapter that reads it, or no adapter when stdin
 *  isn't JSON or `--agent` names an unknown tool. Never throws. */
export function readHookInput(stdinText: string, requested: string | null): { payload: unknown; agent: Agent | null } {
  try {
    const payload: unknown = JSON.parse(withoutBom(stdinText) || "{}");
    return { payload, agent: resolveAgent(payload, process.env, requested) };
  } catch {
    return { payload: undefined, agent: null };
  }
}
