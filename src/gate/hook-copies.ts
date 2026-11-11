// Several copies of the gate's hook can run on one event: one from each repo hook
// file the tool runs, and one from each plugin (Cursor also runs the Claude Code
// plugin it imports). They can't see each other. This decides which copy speaks,
// so each push is checked once and a session gets each line once. A copy steps
// aside for a repo hook file the tool always runs; the copies left claim the
// event (hook-claims.ts), and only the first to claim it speaks.
// docs/agents.md, "Step-aside rules".

import { join } from "node:path";
import type { Agent, HookEvent } from "./agents/index.js";
import { claimHookRun } from "./hook-claims.js";
import { projectHookRunsGate } from "./project-hooks.js";

/** Where a hook run comes from: a plugin's hook file, or one of the repo's. */
export type HookSource = "plugin" | "repo";

/** One run of the gate's hook. `requested` is its --agent, which tells which of
 *  the repo's hook files a repo run came from. */
export interface HookRun {
  readonly agent: Agent;
  readonly event: HookEvent;
  readonly source: HookSource;
  readonly requested: string | null;
}

/** Should this run step aside for a copy that's sure to run? A plugin's run steps
 *  aside when a repo hook file the tool always runs, runs the gate. A run from
 *  one of the repo's files steps aside when such a file, more specific than its
 *  own, does: .claude/settings.json in Cursor once .cursor/hooks.json runs the gate. */
export function stepsAside(run: HookRun, root: string): boolean {
  const files = run.agent.projectHookFiles;
  const own = run.source === "plugin" ? files.length : files.findIndex((h) => h.file.agentFlag === run.requested);
  return files
    .slice(0, Math.max(own, 0))
    .some((h) => h.alwaysRuns && projectHookRunsGate(join(root, h.file.path), h.file, run.event));
}

/** Did this run claim the event first? Copies that would say the same thing share
 *  a key: every copy that checks a push, and each source at session start (a
 *  plugin's run and the repo's say different things). `where` is the repo, so the
 *  same id in two repos counts twice. Events without an id aren't claimed, and
 *  every copy speaks. */
export function claimed(run: HookRun, payload: unknown, where: string): boolean {
  return claim(run, payload, where, run.event === "sessionStart" ? run.source : "check");
}

/** Did this run claim the gate's context at session start first? Both sources give
 *  it in a tool whose repo hook file the plugin can't count on (Codex runs it only
 *  once trusted), so they share one claim, and the session gets it once. */
export function claimedGateContext(run: HookRun, payload: unknown, where: string): boolean {
  return claim(run, payload, where, "gate-context");
}

/** `topic` is what the copies would say: a check, a source's session lines, the gate's context. */
function claim(run: HookRun, payload: unknown, where: string, topic: string): boolean {
  const id = run.agent.eventId(payload, run.event);
  return id === null || claimHookRun([run.agent.id, run.event, topic, id, where].join(":"));
}
