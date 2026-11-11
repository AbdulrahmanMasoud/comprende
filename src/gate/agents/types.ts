// The interface every AI coding tool's adapter implements. The core decides what
// to do (block an unverified push, add session context); an adapter only reads its
// tool's hook payloads and knows its tool's repo-level hook files. See docs/agents.md.

import type { ExistingFile } from "../files.js";

/** The tools the gate has an adapter for. */
export type AgentId = "claude-code" | "cursor" | "codex";

/** The environment a hook runs with, read-only. */
export type HookEnv = Readonly<Record<string, string | undefined>>;

/** The hook events the gate takes part in: a shell command about to run, and a session starting. */
export type HookEvent = "shell" | "sessionStart";

/** The core's verdict on a command: let it run, or block it with a reason the agent sees. */
export type Decision = { readonly allow: true } | { readonly allow: false; readonly reason: string };

/** What a hook prints, and how it exits: 0 or 2. A hook blocks only on a
 *  deliberate deny, a verdict on the change: exit 2, or a tool's own deny reply
 *  from formatDecision. A crash, a usage error or bad input never produces one. */
export interface HookReply {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: 0 | 2;
}

export interface Agent {
  /** For `--agent`, and for the registry's order. */
  readonly id: AgentId;

  /** Is this hook run from this tool? Used only when the hook command doesn't
   *  pass `--agent`: the Claude-format command runs in more than one tool. */
  detects(payload: unknown, env: HookEnv): boolean;

  /** The shell command about to run, or null when the payload isn't for this
   *  tool's shell tool (Claude Code's "Bash", Cursor's "Shell"). */
  shellCommand(payload: unknown): string | null;

  /** The repo the hook is for, or null when this run can't tell: the hook then
   *  steps aside. The core never guesses from its own working folder, because a
   *  tool may run plugin hooks from the plugin's folder (Cursor does). */
  projectDir(payload: unknown, env: HookEnv): string | null;

  /** How the gate's messages name this tool: the assistant the user asks
   *  ("Ask Claude to …"), and the app to restart ("a restart of Claude Code"). */
  readonly names: { readonly assistant: string; readonly app: string };

  /** How the user updates the plugin in this tool, for a message. */
  readonly pluginUpdateHint: string;

  /** For a tool that can skip an installed plugin's hooks without a word (Codex, until
   *  they're trusted): how to get the plugin running, as two options, install it or
   *  trust its hooks, since the note can't tell a teammate without the plugin from
   *  skipped hooks. The repo's own hook file says it at session start, in a gated
   *  repo (hooks.ts). Leave it out for a tool that runs an installed plugin's hooks
   *  without asking. */
  readonly pluginNotRunningHint?: string;

  /** The repo-level hook files this tool runs, most specific first; `install`
   *  writes them. `alwaysRuns` is false for a file the tool runs only while a
   *  setting is on: no other copy of the gate can count on that one running
   *  (hook-copies.ts). */
  readonly projectHookFiles: readonly { readonly file: ProjectHookFile; readonly alwaysRuns: boolean }[];

  /** The id this tool gives a hook event, the same for every hook it runs on it
   *  (a tool call's id, a session's id), or null to claim nothing. Copies of the
   *  gate that can't count on each other claim it, so only one of them speaks. */
  eventId(payload: unknown, event: HookEvent): string | null;

  /** How this tool wants allow and deny. Leave it out for the core's default:
   *  exit 0 with nothing printed, or exit 2 with the reason on stderr. */
  formatDecision?(decision: Decision): HookReply;

  /** The session-start reply (stdout) that adds `lines` to the agent's context.
   *  Leave it out for the core's default: Claude Code's
   *  hookSpecificOutput.additionalContext, which Cursor accepts too. */
  formatSessionContext?(lines: readonly string[]): string;
}

/** A repo-level hook file that registers the gate's hook, such as .claude/settings.json. */
export interface ProjectHookFile {
  /** The path from the repo root. */
  readonly path: string;

  /** The `--agent` its commands pass, or null for Claude Code's format, whose
   *  commands detect the tool. It tells the core which file started a run. */
  readonly agentFlag: AgentId | null;

  /** The gate feature (features.ts) that makes this a gate file, if it came after
   *  the first release: a CI gate that predates it counts an edit as a change. */
  readonly feature?: string;

  /** Does this file's content already run the gate for `event`? */
  runsGate(content: string, event: HookEvent): boolean;

  /** The content with the gate's hook added and everything else kept, plus what
   *  install reports. No content means leave the file alone: the hook is already
   *  there, or the file can't be read or has a shape this adapter doesn't
   *  understand. Pure: the core does the safe read and the atomic write.
   *  `shownPath` is for messages. */
  withGateHook(existing: ExistingFile, shownPath: string): { readonly content?: string; readonly message: string };
}
