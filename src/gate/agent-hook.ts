// The AI tools' PreToolUse hook: the agent's push command, checked against the
// ownership report, with the reply in each tool's format through its adapter (agents/).

import { join } from "node:path";
import { lstat } from "../util.js";
import type { HookEnv, HookReply } from "./agents/index.js";
import { checkForHook } from "./commands.js";
import { repoRoot } from "./git.js";
import { claimed, type HookRun, type HookSource, stepsAside } from "./hook-copies.js";
import { readHookInput } from "./hook-input.js";
import { decisionReply, SILENT_ALLOW } from "./hook-replies.js";
import { isPushCommand } from "./push-detect.js";
import { uncommittedReport } from "./report.js";
import { CONFIG_PATH } from "./shared.js";

/** The PreToolUse hook, for every AI tool: the adapter reads the payload, and the
 *  reply is in the adapter's format, by default exit 2 with stderr to block and
 *  nothing to allow (hook-replies.ts). It checks the current branch; pushes of other
 *  branches are checked by the pre-push hook and CI. Outside a repo with the gate
 *  installed, for an unknown tool, or on an unexpected crash, it allows the call:
 *  this hook is a reminder; CI is the lock. When several copies of the hook run
 *  on the command, only one checks (hook-copies.ts). The plugin never executes
 *  code from the repo it's looking at; it applies its own logic to the repo's data. */
export function agentHook(stdinText: string, source: HookSource, requested: string | null): HookReply {
  const { payload, agent } = readHookInput(stdinText, requested);
  if (!agent) return SILENT_ALLOW;
  const env: HookEnv = process.env;
  const allow = decisionReply(agent, { allow: true });
  const run: HookRun = { agent, event: "shell", source, requested };
  let root: string;
  try {
    const command = agent.shellCommand(payload);
    if (command === null || !isPushCommand(command)) return allow;
    const dir = agent.projectDir(payload, env);
    if (dir === null) return allow; // the tool didn't say which repo: step aside
    root = repoRoot(dir);
    if (!lstat(join(root, CONFIG_PATH))) return allow;
    if (stepsAside(run, root) || !claimed(run, payload, root)) return allow;
  } catch {
    return allow;
  }
  const check = checkForHook(root, { assistant: agent.names.assistant }, false);
  if ("skipped" in check || check.passed || check.mode !== "required") return allow;
  // The hook runs before the command, so `git commit … && git push` is checked
  // against the old HEAD. Say so when the fix is just a separate commit.
  const pending = uncommittedReport(root);
  if (pending) {
    return decisionReply(agent, {
      allow: false,
      reason:
        `Blocked by the ownership gate: the report ${pending} is saved but not committed. Commit it first, then push as a separate command. ` +
        "This hook checks the branch before a command runs, so a push in the same command as the commit is blocked too.",
    });
  }
  return decisionReply(agent, {
    allow: false,
    reason: `Blocked by the ownership gate:\n- ${check.problems.join("\n- ")}`,
  });
}
