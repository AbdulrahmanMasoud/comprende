// The repo's .cursor/hooks.json as a project hook file: the gate's shell hook and
// session start, which install adds for teammates on Cursor. Cursor's format, with
// plain node commands and no shell syntax: on Windows Cursor runs hooks in
// PowerShell. Project hooks run from the repo's root, so the path is relative.
// https://cursor.com/docs/hooks

import { isRecord } from "../../util.js";
import { GATE_REL } from "../shared.js";
import { isGateCommand } from "./gate-command.js";
import type { HookEvent, ProjectHookFile } from "./types.js";

const LABEL = "Cursor hooks";

const HOOK_BY_HAND =
  "add the hooks by hand: https://github.com/AbdulrahmanMasoud/comprende/blob/main/docs/teams.md#add-the-cursor-hooks-by-hand";

// failClosed false: a hook may block only on a deliberate exit 2. Without node,
// the command fails with another code, so Cursor lets the command run.
const ENTRIES: Record<HookEvent, { key: string; entry: Record<string, unknown> }> = {
  shell: {
    key: "preToolUse",
    entry: { matcher: "Shell", command: `node ${GATE_REL} agent-hook --agent cursor`, timeout: 60, failClosed: false },
  },
  sessionStart: {
    key: "sessionStart",
    entry: { command: `node ${GATE_REL} session-start --from-repo --agent cursor`, timeout: 30, failClosed: false },
  },
};

const runsGateFor = (hooks: Record<string, unknown>, event: HookEvent): boolean => {
  const list = hooks[ENTRIES[event].key];
  return Array.isArray(list) && list.some((h) => isRecord(h) && isGateCommand(h.command, event));
};

/** The file as install writes it: one line per key, and each event's hooks on one
 *  line. A fresh file is 7 lines, so adding it is a small change (one question)
 *  while the base branch's gate doesn't know it yet. */
function formatHooksFile(file: Record<string, unknown>): string {
  const line = (key: string, value: unknown) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  const top = Object.entries(file).map(([key, value]) =>
    key === "hooks" && isRecord(value)
      ? `  "hooks": {\n${Object.entries(value)
          .map(([event, list]) => `    ${line(event, list)}`)
          .join(",\n")}\n  }`
      : `  ${line(key, value)}`,
  );
  return `{\n${top.join(",\n")}\n}\n`;
}

export const CURSOR_HOOKS: ProjectHookFile = {
  path: ".cursor/hooks.json",
  agentFlag: "cursor",
  feature: "cursor-hooks",

  runsGate(content, event) {
    let file: unknown;
    try {
      file = JSON.parse(content);
    } catch {
      return false;
    }
    return isRecord(file) && isRecord(file.hooks) && runsGateFor(file.hooks, event);
  },

  withGateHook(existing, shownPath) {
    if (existing !== null && "unreadable" in existing) return { message: `SKIPPED ${LABEL}: ${existing.unreadable}` };
    let file: Record<string, unknown> = { version: 1 };
    if (existing !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing.text || "{}");
      } catch {
        return { message: `SKIPPED ${LABEL}: ${shownPath} is not valid JSON; ${HOOK_BY_HAND}` };
      }
      if (!isRecord(parsed)) return { message: `SKIPPED ${LABEL}: ${shownPath} is not a JSON object; ${HOOK_BY_HAND}` };
      file = parsed;
    }
    // Never replace a value we don't understand: that would drop the user's hooks.
    if (file.hooks !== undefined && !isRecord(file.hooks))
      return { message: `SKIPPED ${LABEL}: "hooks" in ${shownPath} is not an object; ${HOOK_BY_HAND}` };
    file.version ??= 1;
    file.hooks ??= {};
    const hooks = file.hooks as Record<string, unknown>;
    let added = 0;
    for (const event of ["shell", "sessionStart"] as const) {
      const { key, entry } = ENTRIES[event];
      if (hooks[key] !== undefined && !Array.isArray(hooks[key]))
        return { message: `SKIPPED ${LABEL}: "hooks.${key}" in ${shownPath} is not a list; ${HOOK_BY_HAND}` };
      if (runsGateFor(hooks, event)) continue;
      hooks[key] = [...((hooks[key] as unknown[] | undefined) ?? []), entry];
      added++;
    }
    if (!added) return { message: `${LABEL} already present (${shownPath})` };
    return {
      content: formatHooksFile(file),
      message: `merged the gate's Cursor hooks into ${shownPath} (other hooks kept)`,
    };
  },
};
