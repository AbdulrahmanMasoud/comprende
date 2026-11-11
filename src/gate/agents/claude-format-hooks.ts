// A repo-level hook file in Claude Code's format, which Codex uses too:
// {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", …}]}]}}.
// Whether it runs the gate, and merging the gate's shell hook in, for
// .claude/settings.json (claude-settings.ts) and .codex/hooks.json (codex-hooks.ts).

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
  /** How install's messages name the hook, e.g. "Claude hook". */
  readonly label: string;
  /** The tool's name in install's "merged a … hook" message. */
  readonly tool: string;
  /** What to do when the file can't be merged: a link to the by-hand steps. */
  readonly byHand: string;
  /** The PreToolUse group install adds. */
  readonly group: Record<string, unknown>;
  /** The file's text, as install writes it. */
  readonly format: (file: Record<string, unknown>) => string;
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
      if (hooks.PreToolUse !== undefined && !Array.isArray(hooks.PreToolUse))
        return { message: `SKIPPED ${label}: "hooks.PreToolUse" in ${shownPath} is not a list; ${byHand}` };
      hooks.PreToolUse ??= [];
      const groups = hooks.PreToolUse as unknown[];
      if (listsGateHook(groups, "shell")) return { message: `${label} already present (${shownPath})` };
      groups.push(structuredClone(spec.group));
      return {
        content: spec.format(file),
        message: `merged a ${spec.tool} PreToolUse hook into ${shownPath} (other settings kept)`,
      };
    },
  };
}
