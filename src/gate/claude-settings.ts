// The project-level Claude Code hook that install merges into the repo's
// .claude/settings.json, for teammates who don't have the plugin.

import { isRecord, lstat } from "../util.js";
import { atomicWrite, MAX_CONFIG_BYTES, readRepoFile } from "./files.js";
import { GATE_REL } from "./shared.js";

// Without node, exit 0: any other non-2 code would still be shown as a hook error on every Bash call.
const CLAUDE_HOOK_COMMAND = `command -v node >/dev/null 2>&1 || exit 0; exec node "$CLAUDE_PROJECT_DIR/${GATE_REL}" claude-hook`;

const HOOK_BY_HAND =
  "add the hook by hand: https://github.com/AbdulrahmanMasoud/comprende/blob/main/docs/teams.md#add-the-claude-hook-by-hand";

export function mergeClaudeSettings(path: string): string {
  let settings: Record<string, unknown> = {};
  if (lstat(path)) {
    let raw: string;
    try {
      raw = readRepoFile(path, MAX_CONFIG_BYTES);
    } catch (e) {
      return `SKIPPED Claude hook: ${(e as Error).message}`;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      return `SKIPPED Claude hook: ${path} is not valid JSON; ${HOOK_BY_HAND}`;
    }
    if (!isRecord(parsed)) return `SKIPPED Claude hook: ${path} is not a JSON object; ${HOOK_BY_HAND}`;
    settings = parsed;
  }
  // Never replace a value we don't understand: that would drop the user's settings.
  if (settings.hooks !== undefined && !isRecord(settings.hooks))
    return `SKIPPED Claude hook: "hooks" in ${path} is not an object; ${HOOK_BY_HAND}`;
  settings.hooks ??= {};
  const hooks = settings.hooks as Record<string, unknown>;
  if (hooks.PreToolUse !== undefined && !Array.isArray(hooks.PreToolUse))
    return `SKIPPED Claude hook: "hooks.PreToolUse" in ${path} is not a list; ${HOOK_BY_HAND}`;
  hooks.PreToolUse ??= [];
  const groups = hooks.PreToolUse as { hooks?: { command?: string }[] }[];
  for (const g of groups) {
    for (const h of g?.hooks ?? []) {
      if ((h?.command ?? "").includes("gate.mjs") && (h?.command ?? "").includes("claude-hook"))
        return `Claude hook already present (${path})`;
    }
  }
  groups.push({ matcher: "Bash", hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND, timeout: 60 }] } as never);
  atomicWrite(path, `${JSON.stringify(settings, null, 2)}\n`);
  return `merged a Claude Code PreToolUse hook into ${path} (other settings kept)`;
}
