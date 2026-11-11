// The interface every AI coding tool's adapter implements. The core decides what
// to do (block an unverified push, add session context); an adapter only reads its
// tool's hook payloads and knows its tool's repo-level hook files. See docs/agents.md.

/** The tools the gate has an adapter for. */
export type AgentId = "claude-code" | "cursor";

/** The environment a hook runs with, read-only. */
export type HookEnv = Readonly<Record<string, string | undefined>>;

/** The core's verdict on a command: let it run, or block it with a reason the agent sees. */
export type Decision = { readonly allow: true } | { readonly allow: false; readonly reason: string };

/** What a hook prints, and how it exits. Only 0 and 2: a hook blocks only on a deliberate exit 2. */
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

  /** The repo the hook is for, from the payload or this tool's project
   *  variable, or null when neither says (the core then uses its own cwd). */
  projectDir(payload: unknown, env: HookEnv): string | null;

  /** This tool's repo-level hook files, most specific first. `install` writes
   *  them, and the plugin's hook steps aside when one of them already runs the gate. */
  readonly projectHookFiles: readonly ProjectHookFile[];

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

  /** How install's messages name this hook, such as "Claude hook". */
  readonly label: string;

  /** Does this file's content already run the gate's hook? */
  runsGate(content: string): boolean;

  /** The content with the gate's hook added and everything else kept, plus what
   *  install reports. No content means leave the file alone (the hook is already
   *  there, or the file has a shape this adapter doesn't understand). Pure: the
   *  core does the safe read and the atomic write. `shownPath` is for messages. */
  withGateHook(existing: string | null, shownPath: string): { readonly content?: string; readonly message: string };
}
