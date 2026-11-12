// An AI tool's hook input: the JSON payload on stdin, and the adapter (agents/)
// that reads it. The AI tools' two hook entry points, agent-hook.ts and session-start.ts,
// start here.

import { type Agent, resolveAgent } from "./agents/index.js";
import { withoutBom } from "./shared.js";

/** The hook's payload and the adapter that reads it. No adapter when `--agent` names
 *  an unknown tool, or when stdin isn't JSON and there's no `--agent`. When stdin
 *  isn't JSON, there's no payload, but `--agent` still picks the adapter, so a tool
 *  that reads only its own format, such as Antigravity, still gets it. Never throws. */
export function readHookInput(stdinText: string, requested: string | null): { payload: unknown; agent: Agent | null } {
  try {
    const payload: unknown = JSON.parse(withoutBom(stdinText) || "{}");
    return { payload, agent: resolveAgent(payload, process.env, requested) };
  } catch {
    return { payload: undefined, agent: requested ? resolveAgent(undefined, process.env, requested) : null };
  }
}
