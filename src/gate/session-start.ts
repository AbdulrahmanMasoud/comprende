// The AI tools' SessionStart hook: what the agent is told when a session starts.
// A note when Node.js is older than 20, the always-on line, and in a gated repo the
// gate's context, the note for a plugin that isn't running, and setting up git's
// pre-push hook from the plugin's copy.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isFile, isSymlink, lstat } from "../util.js";
import { type Agent, UNKNOWN_AGENT_NAMES } from "./agents/index.js";
import { loadConfig } from "./config.js";
import { type GateCopyDifference, gateCopyDifference } from "./gate-copy-difference.js";
import { repoRoot } from "./git.js";
import { claimed, claimedGateContext, type HookRun, type HookSource, stepsAside } from "./hook-copies.js";
import { readHookInput } from "./hook-input.js";
import { sessionContextReply } from "./hook-replies.js";
import { installHooks } from "./pre-push-hook.js";
import { CONFIG_PATH, GATE_ATTRIBUTES_LINE, GATE_REL, SELF } from "./shared.js";

const MIN_NODE = 20;

// hooks/hooks.json carries the same note, naming no app, for a missing or unusable
// node: Claude Code and Cursor (which imports Claude Code plugins) both run it.
const nodeNote = (app: string) =>
  `Tell the user in one line that Comprende needs Node.js 20 or newer (install it from https://nodejs.org), then a restart of ${app}.`;

// How the line a plugin's session start always gives begins. A session without it
// had no plugin hooks run: the skill and the repo hook's note look for it. So only
// a hook may send it, never a rule a tool loads without running hooks.
export const PLUGIN_LINE_START = "Comprende is installed";

// The always-on instruction: every session, so explanations don't depend on the
// request sounding like a wish to learn. Fixed text on purpose: nothing read from
// the repo goes into it. Antigravity's plugin ships it as its rule, rules/AGENTS.md.
export const ALWAYS_ON_RULE =
  "Whenever you write or change code in this session, follow the comprende skill: " +
  "explain only what's new, non-obvious, risky or a real decision, briefly, in the user's language and dialect.";

/** The always-on line: the instruction, after the words that say the hooks ran. */
export const ALWAYS_ON = `${PLUGIN_LINE_START}. ${ALWAYS_ON_RULE}`;

// Where the plugin's rule already gives the instruction, the session start only
// says the hooks ran, so the instruction comes once and the skill still knows.
export const HOOKS_RUN_LINE = `${PLUGIN_LINE_START}, and its hooks run in this session.`;

// COMPRENDE_QUIET=1 still sends a line, not nothing: the skill now loads for any
// code change, so it needs telling to stay quiet, and a session with no note at
// all reads to the skill as hooks that didn't run.
// "Replaces": in Antigravity, the plugin's rule still gives the always-on instruction.
export const QUIET_MODE = `${PLUGIN_LINE_START}, in quiet mode, which replaces any always-on Comprende instruction: use the comprende skill only when the user asks for an explanation, or for the ownership gate.`;

/** What the repo's hook file says at session start, in a tool that can skip the
 *  plugin's hooks without a word: how the agent tells, and what it tells the user.
 *  The plugin may not be installed at all, so the note names both cases, and asks
 *  for both options: a real run had the agent tell a user without the plugin to
 *  re-trust hooks they never had. */
const pluginNotRunningNote = (agent: Agent, hint: string) =>
  `If this session didn't also get a note starting with "${PLUGIN_LINE_START}", Comprende's plugin isn't running in ${agent.names.app}: either it isn't installed, or its hooks were skipped. Tell the user once, in one line, in their language, with both options: ${hint}`;

// Why the pre-push hook wasn't installed automatically. Fixed text, like the
// rest of the SessionStart context: nothing read from the repo goes into it.
const untrustedGateNote = (agent: Agent): Record<Exclude<GateCopyDifference, "none">, string> => ({
  content: `This repo's ${GATE_REL} differs from the plugin's copy, so the local pre-push hook was NOT installed automatically. If the user trusts this repo, they can run \`node ${GATE_REL} install-hooks\`; mention this in one line.`,
  "repo-crlf": `This repo's ${GATE_REL} differs from the plugin's copy only in its line endings: git's core.autocrlf checked it out with CRLF. The local pre-push hook trusts only a byte-identical copy, so it was NOT installed automatically. Tell the user in one line to run \`git -c core.autocrlf=false checkout -- ${GATE_REL}\`, then \`node ${GATE_REL} install\`, which adds \`${GATE_ATTRIBUTES_LINE}\` to .gitattributes so it stays that way.`,
  "plugin-crlf": `The plugin's own copy of gate.mjs has CRLF line endings (git's core.autocrlf, in an install from before Comprende 0.2.1), so it differs from this repo's ${GATE_REL} only in its line endings, and the local pre-push hook was NOT installed automatically. Tell the user in one line to update the plugin: ${agent.pluginUpdateHint}.`,
});

/** SessionStart hook: the stdout that adds context for the agent, in the
 *  adapter's format. A plugin's run gives the always-on line (pluginLine) and,
 *  unless the repo's own hook file starts the session, the gate's context. A run from the
 *  repo's hook file gives the gate's context, and the tool's note for a plugin
 *  that isn't running, if it has one. Never throws — a session must always start. */
export function sessionStart(stdinText: string, source: HookSource, requested: string | null): string {
  const { payload, agent } = readHookInput(stdinText, requested);
  const run: HookRun | null = agent && { agent, event: "sessionStart", source, requested };
  if (run && !claimed(run, payload, run.agent.projectDir(payload, process.env) ?? ""))
    return sessionContextReply(agent, []);
  const lines: string[] = [];
  const node = process.versions.node;
  if (Number.parseInt(node, 10) < MIN_NODE)
    lines.push(
      `Comprende is running on Node.js ${node}, which is too old. ${nodeNote((agent?.names ?? UNKNOWN_AGENT_NAMES).app)}`,
    );
  if (source === "plugin") lines.push(pluginLine(agent, requested));
  if (run) lines.push(...gatedRepoContext(run, payload));
  return sessionContextReply(agent, lines);
}

/** The line a plugin's session start always gives: the always-on line, or the quiet
 *  one. Where the plugin brings the instruction as a rule (alwaysOnFromRule), only the
 *  words that say the hooks ran, and only from our own hook file, which passes
 *  --agent: a copy converted from the Claude Code plugin may come without the rule. */
function pluginLine(agent: Agent | null, requested: string | null): string {
  if (process.env.COMPRENDE_QUIET === "1") return QUIET_MODE;
  return agent?.alwaysOnFromRule && requested === agent.id ? HOOKS_RUN_LINE : ALWAYS_ON;
}

/** In a repo that uses the gate: tell the agent the repo is gated so the
 *  ownership-check protocol is followed (once, whichever copy claims it first),
 *  from the repo's hook file how to notice the plugin isn't running, and, from a
 *  plugin, install the local pre-push hook if this clone lacks it. Elsewhere: nothing. */
function gatedRepoContext(run: HookRun, payload: unknown): string[] {
  try {
    const dir = run.agent.projectDir(payload, process.env);
    if (dir === null) return [];
    const root = repoRoot(dir);
    if (!lstat(join(root, CONFIG_PATH))) return [];
    const cfg = loadConfig(root);
    if (cfg.mode === "off") return [];
    // Step aside before claiming: a copy that stepped aside but took the claim
    // would leave the copy it stepped aside for without the gate's context.
    const givesGateContext = !stepsAside(run, root) && claimedGateContext(run, payload, dir);
    const lines = givesGateContext
      ? [
          `This repository uses the ownership gate (mode: ${cfg.mode}). For any code change, follow the comprende skill's ownership check (read references/ownership-check.md): brief in-flight questions, a final check before commit/PR, and a saved report.`,
        ]
      : [];
    const hint = run.agent.pluginNotRunningHint;
    if (run.source === "repo" && hint) lines.push(pluginNotRunningNote(run.agent, hint));
    // A run from the repo's hook file is the repo's own gate.mjs: it can't vouch
    // for itself, so only a plugin's copy may set up the git hook.
    if (run.source === "plugin") lines.push(...autoInstallGitHook(run.agent, root));
    return lines;
  } catch {
    return [];
  }
}

/** Install the pre-push hook, which runs the repo's gate on every push, but only
 *  when the repo's gate.mjs is byte-identical to this (trusted) copy. Returns
 *  what to tell the agent. */
function autoInstallGitHook(agent: Agent, root: string): string[] {
  const repoGate = join(root, GATE_REL);
  if (process.env.OWNERSHIP_GATE_NO_AUTO_HOOK === "1" || !isFile(repoGate) || isSymlink(repoGate)) return [];
  const difference = SELF ? gateCopyDifference(readFileSync(repoGate), readFileSync(SELF)) : "content";
  if (difference !== "none") return [untrustedGateNote(agent)[difference]];
  const result = installHooks(root, true)[0];
  if (result.startsWith("installed") || result.startsWith("re-pinned"))
    return [
      "The local pre-push git hook was just installed in this clone; mention it to the user in one line (set OWNERSHIP_GATE_NO_AUTO_HOOK=1 to opt out).",
    ];
  return result.startsWith("SKIPPED") ? [`The gate's pre-push hook wasn't added: ${result}`] : [];
}
