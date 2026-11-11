// Does a command in a repo hook file run this gate? One test for every hook-file
// adapter, so that install and the step-aside rules agree on what counts.

import type { HookEvent } from "./types.js";

/** A command that runs the gate's hook for `event`: agent-hook (or its old name,
 *  claude-hook) for a shell command; session-start --from-repo for a session.
 *  A session-start without --from-repo speaks as a plugin, giving the always-on
 *  line, so it doesn't count: the plugin then still gives the gate's context. */
export const isGateCommand = (command: unknown, event: HookEvent): boolean =>
  typeof command === "string" &&
  command.includes("gate.mjs") &&
  (event === "shell"
    ? /\b(agent|claude)-hook\b/.test(command)
    : /\bsession-start\b/.test(command) && /(^|\s)--from-repo(\s|$)/.test(command));
