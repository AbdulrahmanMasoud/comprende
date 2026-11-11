// `gate.mjs __test <fn> <json>`: the gate's internal functions and constants,
// JSON in and JSON out, for the black-box test suite (test/helpers.mjs). Not a
// public interface.

import { cursorProjectDir } from "./agents/cursor.js";
import { AGENTS, PROJECT_HOOK_FILES, resolveAgent } from "./agents/index.js";
import { collectChanges, isPlumbing } from "./changes.js";
import { escapeMarkdown } from "./ci-summary.js";
import { type Config, isSensitive } from "./config.js";
import { samePath } from "./files.js";
import { GATE_FILES } from "./gate-files.js";
import { repoRoot } from "./git.js";
import { decisionReply } from "./hook-replies.js";
import { ALWAYS_ON, PLUGIN_LINE_START, QUIET_MODE } from "./hooks.js";
import { ciPlatform, REPO_PLATFORM } from "./platforms/index.js";
import { addProjectHook } from "./project-hooks.js";
import { isPushCommand } from "./push-detect.js";
import { parseReport, readReport, renderReport, reportPath } from "./report.js";
import { GATE_REL, GATE_VERSION, GateError, sorted } from "./shared.js";

/** Internal functions, JSON in / JSON out, for the black-box test suite. */
export function testCall(fn: string, a: unknown[]): unknown {
  const s = (i: number) => (a[i] === null || a[i] === undefined ? null : String(a[i]));
  const consts: Record<string, unknown> = {
    GATE_VERSION,
    GATE_FILES,
    // The text install writes into a repo with no CI config yet.
    WORKFLOW: REPO_PLATFORM.ciConfig.withGateJob(null).content,
    CHECK_NAME: REPO_PLATFORM.checkName,
    REPO_GATE: GATE_REL,
    ALWAYS_ON,
    QUIET_MODE,
    PLUGIN_LINE_START,
    // Every adapter, so a per-agent test can check it covers them all.
    AGENT_IDS: AGENTS.map((a) => a.id),
  };
  if (fn in consts) return consts[fn];
  switch (fn) {
    case "collect_changes": {
      const [c, u, mb] = collectChanges(repoRoot(s(0)), String(a[1]), s(2));
      return [c, sorted(u), mb];
    }
    case "read_report":
      return readReport(repoRoot(s(0)), String(a[1]), s(2));
    case "merge_claude_settings": {
      // The test suite's name for adding the hook to a .claude/settings.json at any path.
      const file = PROJECT_HOOK_FILES.find((f) => f.path === ".claude/settings.json");
      return file ? addProjectHook(String(a[0]), file) : null;
    }
    case "ci_platform": {
      // [env]: the platform whose CI this is, and what its environment says.
      const env = (a[0] ?? {}) as Record<string, string>;
      const p = ciPlatform(env);
      return { id: p.id, context: p.ciContext(env), summaryFile: p.reviewerSummaryFile(env) };
    }
    case "cursor_project_dir":
      // [payload, env, platform]
      return cursorProjectDir(a[0], (a[1] ?? {}) as Record<string, string>, String(a[2]));
    case "resolve_agent": {
      // [payload JSON text, env, --agent]: which adapter runs, and what it reads.
      const env = (a[1] ?? {}) as Record<string, string>;
      let payload: unknown;
      try {
        payload = JSON.parse(String(a[0]));
      } catch {
        return null;
      }
      const agent = resolveAgent(payload, env, s(2));
      return (
        agent && { id: agent.id, command: agent.shellCommand(payload), projectDir: agent.projectDir(payload, env) }
      );
    }
    case "allow_reply": {
      // [agent id]: what that adapter prints to let a command run.
      const agent = AGENTS.find((x) => x.id === s(0));
      return agent ? decisionReply(agent, { allow: true }) : null;
    }
    case "is_push_command":
      return isPushCommand(String(a[0]));
    case "is_plumbing":
      // As with a CI gate that knows every feature.
      return isPlumbing(String(a[0]), a[1] === undefined ? "100644" : String(a[1]), () => true);
    case "is_sensitive":
      return isSensitive(String(a[0]), String(a[1]), a[2] as Config);
    case "md_safe":
      return escapeMarkdown(String(a[0]));
    case "report_relpath":
      return reportPath(String(a[0]));
    case "render_report":
      return renderReport(a[0] as Parameters<typeof renderReport>[0]);
    case "parse_report":
      return parseReport(String(a[0]));
    case "same_path":
      return samePath(String(a[0]), String(a[1]), String(a[2]));
    default:
      throw new GateError(`unknown test function ${fn}`);
  }
}
