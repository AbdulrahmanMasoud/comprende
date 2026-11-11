// A repo-level hook file in Claude Code's format, which Codex uses too:
// {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", …}]}]}}.
// Whether it runs the gate, and merging the gate's hooks in, for .claude/settings.json
// (claude-settings.ts: the shell hook) and .codex/hooks.json (codex-hooks.ts: the
// shell hook and a session start).

import { isRecord } from "../../util.js";
import { isGateCommand } from "./gate-command.js";
import type { AgentId, HookEvent, ProjectHookFile } from "./types.js";

/** Claude Code's name for each of the gate's events, which Codex shares. */
const EVENT_KEY: Record<HookEvent, string> = { shell: "PreToolUse", sessionStart: "SessionStart" };

/** Does a list of hook groups run the gate? Entries of a shape we don't know
 *  are skipped, not trusted. */
const listsGateHook = (groups: unknown[], event: HookEvent): boolean =>
  groups.some(
    (g) => isRecord(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isRecord(h) && isGateCommand(h.command, event)),
  );

export interface ClaudeFormatHookFileSpec {
  readonly path: string;
  readonly agentFlag: AgentId | null;
  readonly feature?: string;
  /** How install's messages name the hook ("Claude hook"), and the tool ("Claude Code"). */
  readonly label: string;
  readonly tool: string;
  /** What else the file holds, which install keeps: "settings", "hooks". */
  readonly keeps: string;
  /** What to do when the file can't be merged: a link to the by-hand steps. */
  readonly byHand: string;
  /** The command the gate's hook runs before a shell command. */
  readonly shellCommand: string;
  /** The command for a session start, for a file that has one. */
  readonly sessionStartCommand?: string;
  /** The file's text, as install writes it. */
  readonly format: (file: Record<string, unknown>) => string;
}

/** The gate's hook group for each event the file has, as install adds it. */
function gateGroups(spec: ClaudeFormatHookFileSpec): [HookEvent, Record<string, unknown>][] {
  const groups: [HookEvent, Record<string, unknown>][] = [
    ["shell", { matcher: "Bash", hooks: [{ type: "command", command: spec.shellCommand, timeout: 60 }] }],
  ];
  if (spec.sessionStartCommand)
    groups.push(["sessionStart", { hooks: [{ type: "command", command: spec.sessionStartCommand, timeout: 30 }] }]);
  return groups;
}

export function claudeFormatHookFile(spec: ClaudeFormatHookFileSpec): ProjectHookFile {
  const { label, byHand } = spec;
  return {
    path: spec.path,
    agentFlag: spec.agentFlag,
    ...(spec.feature ? { feature: spec.feature } : {}),

    runsGate(content, event) {
      let file: unknown;
      try {
        file = JSON.parse(content);
      } catch {
        return false;
      }
      const groups = isRecord(file) && isRecord(file.hooks) ? file.hooks[EVENT_KEY[event]] : undefined;
      return Array.isArray(groups) && listsGateHook(groups, event);
    },

    withGateHook(existing, shownPath) {
      if (existing !== null && "unreadable" in existing) return { message: `SKIPPED ${label}: ${existing.unreadable}` };
      let file: Record<string, unknown> = {};
      if (existing !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(existing.text || "{}");
        } catch {
          return { message: `SKIPPED ${label}: ${shownPath} is not valid JSON; ${byHand}` };
        }
        if (!isRecord(parsed)) return { message: `SKIPPED ${label}: ${shownPath} is not a JSON object; ${byHand}` };
        file = parsed;
      }
      // Never replace a value we don't understand: that would drop the user's settings.
      if (file.hooks !== undefined && !isRecord(file.hooks))
        return { message: `SKIPPED ${label}: "hooks" in ${shownPath} is not an object; ${byHand}` };
      file.hooks ??= {};
      const hooks = file.hooks as Record<string, unknown>;
      // All or nothing, like Cursor's: a file with a list we don't understand is
      // left for the user to fix by hand, not half merged.
      const gate = gateGroups(spec);
      const notAList = gate
        .map(([event]) => EVENT_KEY[event])
        .find((key) => hooks[key] !== undefined && !Array.isArray(hooks[key]));
      if (notAList)
        return { message: `SKIPPED ${label}: "hooks.${notAList}" in ${shownPath} is not a list; ${byHand}` };
      const added: string[] = [];
      for (const [event, group] of gate) {
        const key = EVENT_KEY[event];
        const groups = (hooks[key] as unknown[] | undefined) ?? [];
        if (listsGateHook(groups, event)) continue;
        hooks[key] = [...groups, group];
        added.push(key);
      }
      if (!added.length) return { message: `${label} already present (${shownPath})` };
      const hooksAdded =
        added.length === 1 ? `a ${spec.tool} ${added[0]} hook` : `${spec.tool} ${added.join(" and ")} hooks`;
      return {
        content: spec.format(file),
        message: `merged ${hooksAdded} into ${shownPath} (other ${spec.keeps} kept)`,
      };
    },
  };
}
