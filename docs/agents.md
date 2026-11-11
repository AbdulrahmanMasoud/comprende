# Comprende in other AI tools

Comprende runs in Claude Code and, from 0.3.0, in Cursor ([#2](https://github.com/AbdulrahmanMasoud/comprende/issues/2)). Start with [What works where](#what-works-where-030), [What's weaker in Cursor](#whats-weaker-in-cursor-than-in-claude-code) and the [checklist for the IDE](#checking-it-in-the-cursor-ide). The rest of the page is the research behind it, and the design for other tools on the same adapter interface ([#18](https://github.com/AbdulrahmanMasoud/comprende/issues/18)).

- **Cursor:** tested on 2026-11-11 with the Cursor CLI (`cursor-agent`) `2026.11.10-731fb78` on macOS, plus the official docs.
- **Codex:** from its docs only, to check that the design fits a third tool.

Each answer is marked with its source:
- **Tested:** confirmed by a `cursor-agent` run (see [How we tested](#how-we-tested)).
- **Docs:** from official documentation, linked. Forum links are posts by Cursor staff.
- **Unknown:** neither. The row says why, and how much it matters.

A few rows also lean on reading the CLI's bundled JavaScript, and say so.

Terms used below:
- **Fail open:** a hook that crashes or times out lets the command run.
- **Step aside:** a hook exits 0 without checking, because another copy of the gate does the check.
- **Agents window:** the agent panel in the Cursor IDE.
- **Tab:** Cursor's autocomplete.

## The short version

- **Cursor already runs Comprende's Claude Code hooks.** It runs the repo's `.claude/settings.json`, and the hooks of the Claude Code plugins you've installed.
  - It sends them its own payload: the shell tool is called `Shell`, and `cwd` is `""`.
  - Until 0.2.2, the gate's hook therefore let every push through in Cursor ([#17](https://github.com/AbdulrahmanMasoud/comprende/issues/17)). 0.2.2 fixes it.
- **The session-start message reaches the agent, and so does the reason for a block.** That's true in both hook formats.
- **Skills load** from `.cursor/skills`, `.claude/skills` and `.agents/skills`. They load automatically when a request matches the description.
- **Any stdout that isn't JSON blocks the command, even on exit 0.** Empty stdout is fine.
- **On Windows, Cursor runs hooks in PowerShell, where our POSIX `sh` hook commands don't work.** See [Windows](#windows).

## Cursor: what we found

### Hooks (`.cursor/hooks.json`)

| Question | Answer | Source |
|---|---|---|
| Events | `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `subagentStart`, `subagentStop`, `afterAgentResponse`, `afterAgentThought`, `workspaceOpen`, and Tab's `beforeTabFileRead` and `afterTabFileEdit` | Docs: [hooks](https://cursor.com/docs/hooks) |
| `sessionStart` input | `conversation_id`, `generation_id`, `session_id` (all three the same), `model`, `is_background_agent`, `hook_event_name: "sessionStart"`, `cursor_version`, `workspace_roots`, `user_email`, and `transcript_path: null`. There's no `cwd`. The docs also list `composer_mode`, which the CLI didn't send. See [`session-start.json`](../test/fixtures/cursor/session-start.json) | Tested |
| `preToolUse` input for the shell | `tool_name: "Shell"`, `tool_input: { command, cwd: "", timeout }`, `tool_use_id`, `cwd: ""`, plus the common fields. See [`pre-tool-use.shell.git-push.json`](../test/fixtures/cursor/pre-tool-use.shell.git-push.json) | Tested |
| `preToolUse` for another tool | Read: `tool_name: "Read"`, `tool_input: { file_path }`. See [`pre-tool-use.read.json`](../test/fixtures/cursor/pre-tool-use.read.json) | Tested |
| `beforeShellExecution` input | `command`, `cwd: ""`, `sandbox: false`, the same `tool_use_id` as `preToolUse`, plus the common fields | Tested |
| Order | `preToolUse` runs first. If it denies, `beforeShellExecution` doesn't run | Tested |
| Permission output | `{"permission": "allow" \| "deny" \| "ask", "user_message", "agent_message"}`. `ask` isn't enforced for `preToolUse` | Tested (allow, deny). Docs: [hooks](https://cursor.com/docs/hooks) (`ask`) |
| What the agent sees on a JSON deny | `user_message`, inside the tool's rejection: `Command execution was blocked by a hook: <user_message>`. `agent_message` never reached the agent, for `preToolUse` or `beforeShellExecution` | Tested (CLI) |
| What the person sees on a deny | The CLI prints the same rejection. The IDE's display isn't known. It matters little, because exit 2 with stderr works everywhere | Tested (CLI). Unknown (IDE only) |
| Exit 0, empty stdout | Allowed | Tested |
| Exit 0, stdout that isn't JSON | Blocked: `Hook "…" returned invalid JSON. The command was blocked for safety.` | Tested |
| Exit 2, with the reason on stderr | Blocked. The agent sees `Hook blocked with message: <stderr>` | Tested |
| Exit 1 (a crash) | Allowed: hooks fail open | Tested |
| `failClosed` | Per hook, default `false`. When `true`, a crash, timeout or missing output blocks | Docs: [hooks](https://cursor.com/docs/hooks). Not tested |
| Timeout | Per hook, in seconds. The default is listed as "platform default", which staff say is a minute. A timeout fails open | Docs: [hooks](https://cursor.com/docs/hooks), [forum](https://forum.cursor.com/t/174713) |
| `sessionStart` output | `additional_context` reaches the agent, and so does Claude's `hookSpecificOutput.additionalContext`. `env` reaches later hooks in the same run, but not after `--resume`, which is a new process | Tested |
| `sessionStart` on `--resume` | It doesn't run again. The context from the first turn stays in the chat | Tested |
| A hook's environment | `CURSOR_PROJECT_DIR` and `CLAUDE_PROJECT_DIR` (the same path), `CURSOR_VERSION`, `CURSOR_USER_EMAIL`, `CURSOR_TRANSCRIPT_PATH`, `CURSOR_INVOKED_AS`, `CURSOR_RIPGREP_PATH`. See [`hook-env.json`](../test/fixtures/cursor/hook-env.json) | Tested |
| Working directory | Project hooks run from the project root, and plugin hooks from the plugin's folder. User hooks run from `~/.cursor/` | Tested (project, plugin). Docs: [hooks](https://cursor.com/docs/hooks) (user) |
| The shell on macOS | `zsh`. `PATH` is rebuilt as in a login shell, so the system folders come first | Tested |
| Workspace trust | Project hooks need a trusted workspace. Headless runs need `--trust` | Docs: [hooks](https://cursor.com/docs/hooks), [CLI changelog](https://cursor.com/docs/cli/changelog). We always passed `--trust` |
| `--force` | Hooks still apply. Every deny above ran with `--force` | Tested |

### Claude-format hooks ("third-party hooks")

| Question | Answer | Source |
|---|---|---|
| Files read | `.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/settings.json` | Tested (`.claude/settings.json`). Docs: [third-party hooks](https://cursor.com/docs/reference/third-party-hooks) |
| Claude Code plugins | Imported from `~/.claude/plugins`. The installed Comprende 0.2.0 ran its SessionStart in Cursor, and the agent got its message | Tested |
| The on/off setting | "Include Third-Party Plugins, Skills, and Other Configs", in Settings → Agents → Third-Party Imports. It's on by default, but off for Enterprise accounts that haven't set it. Staff say the CLI ignores it | Docs: [third-party hooks](https://cursor.com/docs/reference/third-party-hooks), [3.0 changelog](https://cursor.com/changelog/3-0), [forum](https://forum.cursor.com/t/168407) |
| Event mapping | `SessionStart` → `sessionStart` and `PreToolUse` → `preToolUse`. `Notification` and `PermissionRequest` aren't supported | Tested (the first two). Docs: [third-party hooks](https://cursor.com/docs/reference/third-party-hooks) (the rest) |
| Tool mapping | `"matcher": "Bash"` fires for Cursor's `Shell`. A hook with no matcher also gets the other tools, such as Read | Tested |
| Input shape | Cursor's. A Claude-format hook gets the same stdin as a `.cursor/hooks.json` hook, so `tool_name: "Shell"`, `hook_event_name: "preToolUse"` and `cwd: ""` | Tested |
| Exit 0, empty stdout | Allowed. Comprende's allow path relies on this | Tested |
| Exit 0, plain text on stdout | Blocked as invalid JSON, unlike in Claude Code | Tested |
| Exit 2, with the reason on stderr | Blocked. The agent sees `Hook blocked with message: <stderr>` | Tested |
| SessionStart `hookSpecificOutput.additionalContext` | Reaches the agent | Tested |
| `$CLAUDE_PROJECT_DIR` and `${CLAUDE_PROJECT_DIR}` in a command | Both expand to the project root | Tested |
| The same hook in both formats | It runs twice | Docs: [forum](https://forum.cursor.com/t/174713) |

### Plugins

| Question | Answer | Source |
|---|---|---|
| `.cursor-plugin/plugin.json` | Only `name` (kebab-case) is required. Optional: `description`, `version`, `author`, `homepage`, `repository`, `license`, `keywords`, `logo`, and paths for `rules`, `agents`, `skills`, `commands`, `hooks` and `mcpServers` | Docs: [plugins reference](https://cursor.com/docs/reference/plugins) |
| Component paths | `skills/<name>/SKILL.md`, `rules/`, `agents/`, `commands/`, `hooks/hooks.json`, and `mcp.json` at the root. A path in the manifest replaces discovery for that component | Docs: [plugins reference](https://cursor.com/docs/reference/plugins) |
| Hooks inside a plugin | Cursor's format. A manifest `"hooks"` path pointing to a Cursor-format file worked | Tested. Docs: [plugins reference](https://cursor.com/docs/reference/plugins) |
| `.claude-plugin/` next to `.cursor-plugin/` | Both can live in one folder. Cursor loaded the plugin through `.cursor-plugin/plugin.json` and didn't run the Claude-format `hooks/hooks.json` | Tested (`--plugin-dir`) |
| The plugin root in hook commands | Cursor replaces `${CURSOR_PLUGIN_ROOT}` with the plugin's folder as text, before the shell runs: it worked inside single quotes. `${CLAUDE_PLUGIN_ROOT}` expands in Claude Code plugins too. Plugin hooks get both `CURSOR_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` in the environment | Tested |
| The plugin root in MCP config | Both `${CURSOR_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` expand. Our `.mcp.json` uses `${CLAUDE_PLUGIN_ROOT}`, and the server started | Tested (`${CLAUDE_PLUGIN_ROOT}`). Docs: [plugins reference](https://cursor.com/docs/reference/plugins) |
| `--plugin-dir` with a Claude Code plugin | It works. `--plugin-dir` on this repo loaded Comprende 0.2.1, and its SessionStart and PreToolUse ran | Tested |
| Installing | In the IDE: Customize → Install. In the CLI: `agent plugin marketplace add <git-url>`, which needs `.cursor-plugin/marketplace.json` | Docs: [plugins](https://cursor.com/docs/plugins), [CLI changelog](https://cursor.com/docs/cli/changelog). Not tested |
| Team marketplaces | Dashboard → Plugins & MCPs → Add Marketplace, from a Git repo. One for Teams plans, unlimited for Enterprise. Install modes: Default Off, Default On, Required | Docs: [plugins](https://cursor.com/docs/plugins) |
| Publishing | Submit at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish). Plugins must be open source, and every update is reviewed. How long a review takes isn't stated | Docs: [plugins](https://cursor.com/docs/plugins) |

### Skills, MCP and the CLI

| Question | Answer | Source |
|---|---|---|
| Skill folders | In the project: `.cursor/skills`, `.claude/skills`, `.agents/skills`. In your home folder: `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`. Also the skills of installed Claude Code plugins. `~/.cursor/skills` is in the docs, but didn't show up in our run | Tested. Docs: [skills](https://cursor.com/docs/skills) (`~/.cursor/skills`) |
| Loading by description | Yes, for all three project folders. A question matching a skill's description made the agent read that `SKILL.md` and answer from it | Tested |
| Always-on instructions | A rule with `alwaysApply: true` (`.mdc`) | Docs: [rules](https://cursor.com/docs/rules) |
| MCP config | `.cursor/mcp.json` and `~/.cursor/mcp.json`, as `{"mcpServers": {…}}`. A plugin's own file is `mcp.json`, and the manifest's `mcpServers` can point elsewhere | Docs: [MCP](https://cursor.com/docs/mcp), [plugins reference](https://cursor.com/docs/reference/plugins) |
| A plugin's `.mcp.json` | Read when the manifest's `mcpServers` points at it. The memory server started and listed its 10 tools, and `learning_context` answered | Tested (`--plugin-dir`) |
| Hooks in the CLI | `sessionStart`, `preToolUse` and `beforeShellExecution` all ran in `-p` mode | Tested |
| Headless flags | `-p`, `--output-format stream-json`, `--trust`, `--force`, `--resume <chat>`, `--workspace` and `--plugin-dir`. `CURSOR_API_KEY` can stand in for a login | Tested (all but `CURSOR_API_KEY`). Docs: [parameters](https://cursor.com/docs/cli/reference/parameters) |
| Shell commands in `-p` without `--force` | Unknown: we always passed `--force`. It matters only for the end-to-end script | Unknown |
| Commit attribution | The CLI adds a "Made with Cursor" trailer by default (`attribution.attributeCommitsToAgent`). Contributors who use it must turn it off, because of our no-attribution rule | Docs: [CLI configuration](https://cursor.com/docs/cli/reference/configuration) |
| `sessionStart` in the Agents window | Staff say the context arrives after the first request. That matters for the always-on line (decision 4) | Unknown (IDE only). Docs: [forum](https://forum.cursor.com/t/174143) |

### Windows

The docs say: "the desktop app runs hook commands through PowerShell and pipes the JSON into the command" ([hooks](https://cursor.com/docs/hooks)). The 2026.11.10 CLI's bundled JavaScript builds hook commands as PowerShell too. Staff say the CLI switches to Git Bash when it sees Git Bash's environment (`MSYSTEM`), and that it once sent stdin with a UTF-8 BOM ([forum](https://forum.cursor.com/t/168129), [forum](https://forum.cursor.com/t/166794)).

**Unknown by test, because we have no Windows machine with Cursor.** It matters a lot, since many Cursor users are on Windows:

- **Today's hook commands are POSIX `sh`:** `command -v node … || exit 0; exec node "$CLAUDE_PROJECT_DIR/…"`. PowerShell can't run them. They fail with an exit code other than 2, so they fail open. Nothing breaks, but nothing is checked either.
- **The git pre-push hook still works,** because git runs hooks through its own `sh`.
- **The design below uses plain `node <relative path> <command>` lines.** These run in both shells. It also strips a BOM before parsing the payload.

Windows as a whole is tracked in [#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10).

## What works where (0.3.0)

| | Claude Code | Cursor |
|---|---|---|
| The skill (explain as you build) | yes | yes, the same `skills/` (tested in the CLI) |
| Memory (the MCP server) | yes | yes, all 10 tools, once the server is approved (tested in the CLI) |
| The always-on line | at session start | at session start, from the plugin's `sessionStart` hook (tested in the CLI) |
| The push guard (the agent's `git push`) | the plugin, or the repo's `.claude/settings.json` | the plugin, or the repo's `.cursor/hooks.json`. Also `.claude/settings.json` and an imported Claude Code plugin, while Third-Party Imports is on (tested in the CLI) |
| The git `pre-push` hook | installed by the plugin at session start | the same (tested in unit tests, not in the CLI run) |
| CI | the same check: it doesn't depend on the tool | the same |
| Windows | experimental: hooks run in Git Bash | experimental and untested: hooks run in PowerShell, and the commands are plain `node` lines ([#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10)) |

Each push is checked once, whatever mix of hook files and plugins is present ([Step-aside rules](#step-aside-rules)).

## What's weaker in Cursor than in Claude Code

- **No marketplace listing yet.** You install from a local folder, and update with `git pull`. On Enterprise, **Allow Local Plugin Imports** is off by default, and then a local plugin doesn't load. The repo's `.cursor/hooks.json`, the git hook and CI still check.
- **Windows is untested** ([Windows](#windows)).
- **Stdout is stricter.** One stray line on stdout blocks every shell command, where in Claude Code it's harmless. Our hook prints nothing when it allows, and a test checks that.
- **Session context is less reliable.** In the Agents window it arrives late. A resumed chat keeps the first turn's context, but the `env` set at session start is gone.
- **Several copies of the hook can run.** Up to four, on one command. They agree on one check, but a copy from before 0.3.0 doesn't, and may check a second time ([Step-aside rules](#step-aside-rules)).
- **A JSON deny can't send a separate note to the agent.** Only `user_message` reaches it. Exit 2 with stderr is the same for everyone.
- **The MCP server needs approval** (`--approve-mcps` in headless runs). Until then, the memory tools aren't there, and "check me" saves the report with `gate.mjs save --input` instead.
- **The skill can load twice.** Cursor also runs the Claude Code plugins you've installed. Install Comprende in one place.
- **Cursor's agent signs its commits.** It adds `Co-authored-by: Cursor <cursoragent@cursor.com>` to the commits it makes. Turn that off in Cursor's settings if you don't want it.

## Checking it in the Cursor IDE

The CLI run (`tools/e2e-cursor.mjs`) can't see the IDE. Check these by hand, in a gated demo repo (the README's "Try it in 5 minutes"):

1. **Install:** `git clone https://github.com/AbdulrahmanMasoud/comprende.git ~/.cursor/plugins/local/comprende`, then **Developer: Reload Window**. Comprende shows in **Customize**.
2. **Memory:** approve the **comprende** MCP server if Cursor asks. Its 10 tools are listed.
3. **Session start:** open the demo, trust the workspace, start a chat, and ask what Comprende said at session start. Expect the always-on line and the gate's message, in the Agents window too.
4. **An ordinary command:** ask it to run `ls`. It runs, with no hook message.
5. **The push guard:** ask it to add `sum(xs)` to `math.js`, commit and push. The push is blocked, and the chat shows why.
6. **Check me:** say "check me", answer, and write a summary. The report is saved and committed, then a separate push goes through.
7. **One check:** with Comprende also in Claude Code (so Cursor imports it), push an unverified change. The chat shows one block message, not two.
8. **Third-Party Imports off:** turn it off, reload, and push an unverified change. It's still blocked.

## Codex, from its docs

We read these only to check that the design fits a third tool. Not tested.

| Question | Answer | Source |
|---|---|---|
| Hooks | `hooks.json`, or `[hooks]` in `config.toml`, in `~/.codex/` or `<repo>/.codex/`. Events include `SessionStart` and `PreToolUse`. Each hook has to be trusted once, and again after a bundled script changes | Docs: [hooks](https://learn.chatgpt.com/docs/hooks) |
| Shell payload | `tool_name: "Bash"`, `tool_input.command`, `cwd`, `session_id`, `hook_event_name` | Docs: [hooks](https://learn.chatgpt.com/docs/hooks) |
| Allow and deny | Exit 0 with no output allows. Exit 2 with the reason on stderr denies, and so does `hookSpecificOutput.permissionDecision: "deny"`. Other failures let the tool run | Docs: [hooks](https://learn.chatgpt.com/docs/hooks) |
| Session context | Plain stdout, or `hookSpecificOutput.additionalContext` | Docs: [hooks](https://learn.chatgpt.com/docs/hooks) |
| Plugins | A root `plugin.json`, or `.codex-plugin/plugin.json`, with hooks in `hooks/hooks.json`. `PLUGIN_ROOT` is set, and so is `CLAUDE_PLUGIN_ROOT`. Plugins with lifecycle hooks aren't eligible for the public directory | Docs: [plugins](https://developers.openai.com/plugins/build/plugins) |
| Skills | `.agents/skills`, from the working folder up to the repo root, plus `~/.agents/skills`. Skills are picked by description | Docs: [skills](https://learn.chatgpt.com/docs/build-skills) |
| Windows | Each hook can set an optional `commandWindows`. Which shell runs hooks isn't documented | Docs: [hooks](https://learn.chatgpt.com/docs/hooks) |

## Design proposal

### What the three tools share

- **Allowing:** exit 0 with empty stdout allows, in all three tools and in both of Cursor's formats.
- **Denying:** exit 2 with the reason on stderr denies everywhere, and the reason reaches the agent.
- **Session context:** `hookSpecificOutput.additionalContext` reaches the agent everywhere.

So the replies live in the core, once. What differs is the input:
- the shell tool's name (`Bash` or `Shell`)
- where the repo comes from (`cwd`, or a project variable when `cwd` is `""`)
- the repo-level hook files

Plugin roots differ too, but only in the hook files we ship, not in the gate's code: the gate finds itself through its own path (`SELF`).

### The agent-adapter interface

Built in [#18](https://github.com/AbdulrahmanMasoud/comprende/issues/18):
- the interface is [`src/gate/agents/types.ts`](../src/gate/agents/types.ts)
- one adapter per tool: `claude-code.ts` and `cursor.ts`. Cursor's adapter only reads input for now.
- the registry and the resolve step are in `index.ts`

To add a tool, see "Adding an AI tool" in [CONTRIBUTING.md](../CONTRIBUTING.md#adding-an-ai-tool).

```ts
/** The tools the gate has an adapter for. */
export type AgentId = "claude-code" | "cursor";

/** The environment a hook runs with, read-only. */
export type HookEnv = Readonly<Record<string, string | undefined>>;

/** The hook events the gate takes part in: a shell command about to run, and a session starting. */
export type HookEvent = "shell" | "sessionStart";

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

  /** The repo the hook is for, or null when this run can't tell: the hook then
   *  steps aside. The core never guesses from its own working folder, because a
   *  tool may run plugin hooks from the plugin's folder (Cursor does). */
  projectDir(payload: unknown, env: HookEnv): string | null;

  /** How the gate's messages name this tool: the assistant the user asks
   *  ("Ask Claude to …"), and the app to restart ("a restart of Claude Code"). */
  readonly names: { readonly assistant: string; readonly app: string };

  /** How the user updates the plugin in this tool, for a message. */
  readonly pluginUpdateHint: string;

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

/** (files.ts) A file install may change: missing, its text, or why it can't be read safely. */
export type ExistingFile = { readonly text: string } | { readonly unreadable: string } | null;
```

The default replies live in the core, in `src/gate/hook-replies.ts`. Claude-format payloads, which Claude Code and Cursor both send, are read and validated once, in `agents/claude-format.ts`.

**The resolve step** (`resolveAgent` in `agents/index.ts`) picks the adapter for a hook run:
1. `--agent <id>` wins.
2. Otherwise, detection runs in registry order: Cursor first, then Claude Code, which accepts any payload.
3. An unknown `--agent` resolves to no adapter, and the hook steps aside silently. At session start, the always-on line is still printed, in the default format.

**The two optional methods** are there for tools that reply in JSON. Antigravity, explored in [#16](https://github.com/AbdulrahmanMasoud/comprende/pull/16), wants `{"decision": "deny", "reason": …}` and `injectSteps`. Such a tool fits without touching the core.

**One command, two names.** The hook command is `agent-hook`, and `claude-hook` stays its alias, because existing `.claude/settings.json` files and the plugin's `hooks/hooks.json` call it.

How each tool fills it in:

| | Claude Code | Cursor | Codex (docs) | Antigravity ([#25](https://github.com/AbdulrahmanMasoud/comprende/issues/25), from #16) |
|---|---|---|---|---|
| `detects` | any payload: the fallback | `cursor_version` in the payload, or the tool name `Shell`. Not the environment: Claude Code started from Cursor's terminal may inherit Cursor's variables | `--agent codex` in its hook file | `toolCall` and `workspacePaths` |
| Shell tool | `Bash` | `Shell` | `Bash` | `run_command`, command in `toolCall.args.CommandLine` |
| `projectDir` | `cwd`, else `CLAUDE_PROJECT_DIR`, else its own folder (Claude Code runs hooks from the project) | the one entry in `workspace_roots` (`cwd` is `""`), else `CURSOR_PROJECT_DIR` or `CLAUDE_PROJECT_DIR`, else step aside: Cursor runs plugin hooks from the plugin's folder. With several roots it steps aside, since it can't tell which one the command runs in | `cwd` | `workspacePaths[0]` |
| `names` | Claude, Claude Code | Cursor, Cursor | Codex, Codex | Antigravity, Antigravity |
| `pluginUpdateHint` | `/plugin marketplace update comprende` | the same, since Cursor may be running the Claude Code plugin it imported, or `git -C ~/.cursor/plugins/local/comprende pull` for its own copy | to be found | to be found |
| `projectHookFiles` | `.claude/settings.json`, always run | `.cursor/hooks.json`, always run, then `.claude/settings.json`, run only while Third-Party Imports is on | `.codex/hooks.json` | the plugin's `hooks.json` only |
| `eventId` | the tool call's id; none for a session, since one session runs one plugin copy | the tool call's id, or the session's | to be found | to be found |
| `formatDecision` | the default | the default | the default | `{"decision": …}` |
| `formatSessionContext` | the default | the default | the default | `injectSteps` |

A payload that starts with a UTF-8 BOM is read like any other: the BOM is stripped before parsing. Cursor's CLI on Windows once sent one, and without that the hook would step aside. `save --input` strips one too, since PowerShell 5.1 writes files with one.

The platform adapter is the other half of #18: GitHub now, GitLab later ([#4](https://github.com/AbdulrahmanMasoud/comprende/issues/4)). It covers the CI config, what CI says about the change, the reviewer summary and annotations, CODEOWNERS, the platform CLI's pull-request commands, and `protect`. The `Platform` interface, and how it maps to GitLab, are in CONTRIBUTING.md, under [Adding a git platform](../CONTRIBUTING.md#adding-a-git-platform).

### Step-aside rules

In Cursor, up to four copies of Comprende's hook can run on the same command. Claude Code runs the two in its own format. Cursor runs its own two always, and Claude Code's two only while Third-Party Imports is on.

| Copy | Format | Runs | Steps aside when |
|---|---|---|---|
| The repo's `.cursor/hooks.json` | Cursor | the repo's gate | never: it's the most specific |
| The repo's `.claude/settings.json` | Claude | the repo's gate | it runs in Cursor, and `.cursor/hooks.json` runs the gate |
| The native Cursor plugin (`hooks/cursor-hooks.json`) | Cursor | the plugin's gate | `.cursor/hooks.json` runs the gate (in Claude Code: `.claude/settings.json`) |
| The imported Claude Code plugin (`hooks/hooks.json`) | Claude | the plugin's gate | the same |

A copy steps aside only for a file the tool is sure to run. In Cursor, a plugin doesn't step aside for `.claude/settings.json`: Cursor runs it only while Third-Party Imports is on, which a person or an admin can turn off, and Enterprise accounts start with it off. The repo's copy there may also be a gate from before 0.2.2, which let every Cursor push through.

**The copies left claim the push.** Each claims the tool call's id: an empty file named after it, in a private folder under the system temp folder. Only the first to claim it checks (`src/gate/hook-copies.ts`, `src/gate/hook-claims.ts`). A claim is stale after two minutes, so a session that starts again later under the same id is a new one.

The claims are safe from other users on a shared `/tmp`:
- The folder must be a real folder (not a symlink), owned by you, and private. Otherwise nothing is claimed, and every copy checks.
- The ids aren't known before the event, so no one can claim one in advance.
- Pruning deletes only claim files.

**Session start:**
- The repo's `.cursor/hooks.json` gives only the gate's context. Only a `session-start --from-repo` there counts.
- A plugin gives the always-on line, and the gate's context unless the repo's file already gives it. Two plugins claim the session's id, so only one speaks.
- Only a plugin installs the git hook. A run from the repo's file is the repo's own `gate.mjs`, which can't vouch for itself.

So each push is checked once, and each session gets each line once. `test/agents.test.mjs` checks all 16 combinations of the four copies, in Claude Code and in Cursor, with Third-Party Imports on and off.

**Older copies.** The Claude Code and Cursor plugins update separately. A copy from before 0.3.0 doesn't claim, so next to a newer one it may check a push twice, or give the always-on line twice. That's noisy, never a missed check.

### Files to add for Cursor

- **`.cursor-plugin/plugin.json`:**
  - `name: "comprende"`, the version, description, author, repository, license and logo
  - `"hooks": "./hooks/cursor-hooks.json"`
  - `"mcpServers": "./.mcp.json"`
  - It lives next to `.claude-plugin/`, which we tested. `tools/release.mjs` checks its version together with the others.
- **`.cursor-plugin/marketplace.json`:** for `agent plugin marketplace add https://github.com/AbdulrahmanMasoud/comprende`.
- **`hooks/cursor-hooks.json`,** in Cursor's format:

  ```json
  {
    "version": 1,
    "hooks": {
      "sessionStart": [
        { "command": "node \"${CURSOR_PLUGIN_ROOT}/dist/gate.mjs\" session-start --from-plugin --agent cursor", "timeout": 30, "failClosed": false }
      ],
      "preToolUse": [
        { "matcher": "Shell", "command": "node \"${CURSOR_PLUGIN_ROOT}/dist/gate.mjs\" agent-hook --from-plugin --agent cursor", "timeout": 60, "failClosed": false }
      ]
    }
  }
  ```

  - **`${CURSOR_PLUGIN_ROOT}`:** Cursor replaces it with the plugin's folder as text, before any shell runs. That's tested on macOS, where it worked even inside single quotes, and it's in the CLI's own code. So PowerShell never sees a variable. One exception: PowerShell would expand a `$` in the install path itself, inside the double quotes.
  - **`failClosed: false`:** written out, because a hook may block only on a deliberate exit 2.
  - **Without `node`:** the shell exits with a code other than 2, so the hook fails open.
- **Shared as is:**
  - `skills/`, since Cursor reads `SKILL.md` and loads it by description.
  - The MCP server (`dist/server.mjs`, through `.mcp.json`). Tested with `cursor-agent --plugin-dir`: Cursor read `.mcp.json` through the manifest, expanded `${CLAUDE_PLUGIN_ROOT}`, and listed all 10 tools under `plugin-Comprende-comprende`.
- **No rule file.** The always-on line keeps coming from `sessionStart` (decision 4).

### What `gate.mjs install` writes for teammates on Cursor

**Recommendation:** also write `.cursor/hooks.json`, with a `preToolUse` hook (`matcher: "Shell"`) running `node .learning/gate.mjs agent-hook --agent cursor`. Don't rely only on Cursor importing `.claude/settings.json`.

- **It works with Third-Party Imports off.**
- **It works on Windows.** A relative `node` command runs in PowerShell and in `sh`, and project hooks run from the repo root (tested).
- **It runs once**, by the step-aside rules above.
- **It's protected like the other gate files.** `.cursor/hooks.json` joins `GATE_FILES` and CODEOWNERS.

**Upgrading:** a gate that predates this doesn't know `.cursor/hooks.json` is a gate file. So the exemption gets a feature in the gate's header (`cursor-hooks`), like the `.gitattributes` line in 0.2.1. Until the base branch runs a gate that lists it, the upgrade PR counts the new file as a change: one small-change question, or the skip label.

### Install steps for a Cursor user (0.3.0)

1. Install Node.js 20 or newer.
2. Install the plugin into Cursor's folder for local plugins: `git clone https://github.com/AbdulrahmanMasoud/comprende.git ~/.cursor/plugins/local/comprende`, then **Developer: Reload Window**.
   - Cursor loads a plugin from `~/.cursor/plugins/local/<name>` after a reload, unless local plugin imports are off (Enterprise: **Allow Local Plugin Imports**). A symlink there is skipped. Docs: [plugins](https://cursor.com/docs/plugins). The CLI loads it too (tested).
   - To update: `git -C ~/.cursor/plugins/local/comprende pull`, then reload.
   - If Comprende is already in Claude Code, Cursor imports it, so skip this step.
   - The Cursor Marketplace comes later (decision 2). `agent plugin marketplace add` would register this repo on your Cursor account, through Cursor's server, so it isn't the documented route.
3. Open a repo that uses the gate, and trust the workspace. The repo's `.cursor/hooks.json` does the rest.

### Test plan

**Unit tests from the captured payloads** in [`test/fixtures/cursor/`](../test/fixtures/cursor/):
- Each adapter reads each fixture into a command, or into `null`, and finds the right project folder, including the fallbacks.
- `detects`: Cursor's fixtures and environment are recognized as Cursor, Claude Code payloads as Claude Code, and `--agent` overrides both.
- The core's replies: empty stdout on allow, exit 2 with stderr on deny, and only JSON at session start. A payload with a BOM still parses.
- The `ProjectHookFile`s:
  - `withGateHook` keeps other entries
  - it returns `null` for shapes it doesn't know
  - `install` refuses symlinks
- One test per row of the step-aside table. That includes the native plugin stepping aside for `.cursor/hooks.json`.
- The upgrade: `.cursor/hooks.json` needs no report only once the CI gate lists `cursor-hooks`.

**Real Claude Code payloads,** captured into `test/fixtures/claude-code/` in the refactor.

**Consistency:** `tools/release.mjs` and the consistency test cover `.cursor-plugin/plugin.json`'s version.

**To confirm in the Cursor adapter PR,** by `cursor-agent` runs:
- Cursor starts the MCP server from `.mcp.json`, through the manifest
- `agent plugin marketplace add` works on this repo

**An end-to-end script you can rerun,** [`tools/e2e-cursor.mjs`](../tools/e2e-cursor.mjs), as planned here. How to run it, and what it covers today: CONTRIBUTING.md, [Testing in Cursor](../CONTRIBUTING.md#testing-in-cursor). The plan:
- **Setup:**
  - It needs a logged-in `cursor-agent`, and isn't part of CI.
  - It runs `cursor-agent -p --output-format stream-json --trust --force` with a temporary `HOME`. On macOS, that `HOME` links `~/Library/Keychains`, so the login works and no personal config or plugins load.
- **Steps:**
  1. Build a gated demo repo in a temp folder, with a local bare remote and an unverified commit. Remove the git pre-push hook.
  2. Run `ls`, `git status` and `git push` through the repo's `.cursor/hooks.json`. Expect the first two to run, and the push to be rejected with the gate's message.
  3. The same again through the plugin, loaded with `--plugin-dir`, after removing the repo's hook files.
  4. Save a report, commit it, and push. Expect the push to go through.
  5. Start a new session, and check that the agent can quote the session-start message.

### The order of PRs

1. **The refactor, [#18](https://github.com/AbdulrahmanMasoud/comprende/issues/18), with no change in behavior,** in three PRs:
   - `chore:` split `setup.ts` ([#29](https://github.com/AbdulrahmanMasoud/comprende/pull/29)).
   - `refactor:` the agent adapters. Claude Code and an input-only Cursor adapter, `agent-hook`, and the Claude Code fixtures.
   - `refactor:` the platform adapters, with GitHub's.
2. **`feat:` the Cursor adapter (part of [#2](https://github.com/AbdulrahmanMasoud/comprende/issues/2)).** It brings:
   - `.cursor-plugin/` and `hooks/cursor-hooks.json`
   - `install` writing `.cursor/hooks.json`, behind the `cursor-hooks` feature
   - the BOM handling and the step-aside rules
   - the tests and the end-to-end script
   - the docs its changes touch: `docs/teams.md`, `docs/how-it-works.md`, `SECURITY.md` (the new gate file), and the CHANGELOG under Unreleased
3. **`docs:` the READMEs, then `chore:` release 0.3.0.**
   - Both READMEs, where Cursor is announced, and this page's status.
   - The release, on `chore/release-0.3.0`.

## Decisions

The maintainer settled the open questions on 2026-11-11:

1. **`install` writes `.cursor/hooks.json` too.**
   - Its commands need no POSIX shell: `node .learning/gate.mjs <cmd> --agent cursor`. So they work in PowerShell on Windows, and a missing `node` fails open.
   - A repo with both `.claude/settings.json` and `.cursor/hooks.json` runs the gate once in Cursor. `projectHookFiles` decides who steps aside.
2. **The Cursor Marketplace comes after 0.3.0** has shipped from GitHub and passed a manual check in the IDE.
3. **The skill loaded twice:** for now, document "install it in one place".
4. **The always-on line stays in `sessionStart`.** There's no `alwaysApply` rule. The Cursor plugin's hook commands avoid shell syntax too.
5. **Windows ships as "experimental" for Cursor**, tracked in [#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10).
6. **Release plan:** 0.3.0 is Cursor. 0.4.0 is Codex ([#3](https://github.com/AbdulrahmanMasoud/comprende/issues/3)) and Google Antigravity ([#25](https://github.com/AbdulrahmanMasoud/comprende/issues/25)). 0.5.0 is GitLab ([#4](https://github.com/AbdulrahmanMasoud/comprende/issues/4)).

## How we tested

- **The probe repo.** A throwaway repo with a local bare remote, so pushes went nowhere. It had:
  - hooks in both formats that recorded their stdin and environment, then answered each event's way
  - one command blocked on purpose by each format: a Cursor-format JSON deny with `agent_message`, and a Claude-format exit 2 with stderr
  - a Claude-format allow path kept silent, like Comprende's
  - a skill in each of `.cursor/skills`, `.claude/skills` and `.agents/skills`
- **Extra runs:**
  - a Cursor-format exit 2
  - Claude's `hookSpecificOutput` from a Cursor-format `sessionStart`
  - empty, invalid and crashing output in both formats
  - a probe plugin with `.cursor-plugin/` next to `.claude-plugin/`, loaded with `--plugin-dir`
- **Comprende itself.** The gated demo from CLAUDE.md ("The ownership gate"), with 0.2.1 and then 0.2.2. Its plugin was loaded with `--plugin-dir`. A `NODE_OPTIONS=--import` preload logged each `gate.mjs` run, and left the repo's files untouched.
- **How it was run.** `cursor-agent` in headless mode, with a clean environment and a temporary `HOME`, so no personal config or plugins loaded. The first runs used the real `HOME`. Those show the skills in the home folder, and Cursor importing the installed Claude Code plugins, Comprende 0.2.0 among them.
- **The captures.** The payloads are in [`test/fixtures/cursor/`](../test/fixtures/cursor/), with personal data removed.
