# Comprende in other AI tools

Comprende runs in Claude Code. This page collects what we know about running it in other tools, starting with Cursor ([#2](https://github.com/AbdulrahmanMasoud/comprende/issues/2)), and proposes a design. Nothing here has shipped except the 0.2.2 fix noted below.

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
| The plugin root in MCP config | Both `${CURSOR_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` expand | Docs: [plugins reference](https://cursor.com/docs/reference/plugins). Not tested |
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
| A plugin's `.mcp.json` | Unknown: not documented, and not tested. It matters for sharing ours as is. To test in the Cursor adapter PR | Unknown |
| Hooks in the CLI | `sessionStart`, `preToolUse` and `beforeShellExecution` all ran in `-p` mode | Tested |
| Headless flags | `-p`, `--output-format stream-json`, `--trust`, `--force`, `--resume <chat>`, `--workspace` and `--plugin-dir`. `CURSOR_API_KEY` can stand in for a login | Tested (all but `CURSOR_API_KEY`). Docs: [parameters](https://cursor.com/docs/cli/reference/parameters) |
| Shell commands in `-p` without `--force` | Unknown: we always passed `--force`. It matters only for the end-to-end script | Unknown |
| Commit attribution | The CLI adds a "Made with Cursor" trailer by default (`attribution.attributeCommitsToAgent`). Contributors who use it must turn it off, because of our no-attribution rule | Docs: [CLI configuration](https://cursor.com/docs/cli/reference/configuration) |
| `sessionStart` in the Agents window | Staff say the context arrives after the first request. That matters for the always-on line, see open question 4 | Unknown (IDE only). Docs: [forum](https://forum.cursor.com/t/174143) |

### Windows

The docs say: "the desktop app runs hook commands through PowerShell and pipes the JSON into the command" ([hooks](https://cursor.com/docs/hooks)). The 2026.11.10 CLI's bundled JavaScript builds hook commands as PowerShell too. Staff say the CLI switches to Git Bash when it sees Git Bash's environment (`MSYSTEM`), and that it once sent stdin with a UTF-8 BOM ([forum](https://forum.cursor.com/t/168129), [forum](https://forum.cursor.com/t/166794)).

**Unknown by test, because we have no Windows machine with Cursor.** It matters a lot, since many Cursor users are on Windows:

- **Today's hook commands are POSIX `sh`:** `command -v node … || exit 0; exec node "$CLAUDE_PROJECT_DIR/…"`. PowerShell can't run them. They fail with an exit code other than 2, so they fail open. Nothing breaks, but nothing is checked either.
- **The git pre-push hook still works,** because git runs hooks through its own `sh`.
- **The design below uses plain `node <relative path> <command>` lines.** These run in both shells. It also strips a BOM before parsing the payload.

Windows as a whole is tracked in [#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10).

## Comprende in Cursor today (0.2.2)

| | Claude Code | Cursor |
|---|---|---|
| The skill | yes | yes, imported from the Claude Code plugin |
| The session-start message | yes | yes |
| The pre-push hook, installed at session start | yes | yes |
| The agent's `git push` blocked by the Claude hook | yes | yes, since 0.2.2, once the repo's gate is upgraded |
| `git push --no-verify` blocked | yes | the same as the line above |
| Without the plugin | the repo's `.claude/settings.json` hook | the same, while Third-Party Imports is on |
| On Windows | Git Bash | no agent-side check ([Windows](#windows)) |

## What's weaker in Cursor than in Claude Code

- **It depends on a setting we don't control.** The Claude hook runs only while Third-Party Imports is on. A person or an admin can turn it off, and Enterprise accounts start with it off. Then nothing blocks the agent's push except the git hook and CI.
- **Windows has no agent-side check** ([Windows](#windows)).
- **Stdout is stricter.** One stray line on stdout blocks every shell command, where in Claude Code it's harmless. Our hook prints nothing when it allows, and a test checks that.
- **Session context is less reliable.** In the Agents window it arrives late. A resumed chat keeps the first turn's context, but the `env` set at session start is gone.
- **Hooks can run more than once.** Cursor can run up to four copies of Comprende's hook (see [Step-aside rules](#step-aside-rules)).
- **A JSON deny can't send a separate note to the agent.** Only `user_message` reaches it. Exit 2 with stderr is the same for everyone.
- **MCP servers need approval** (`--approve-mcps` in headless runs). Until then, the memory tools aren't there.

None of this weakens the lock: CI and the ruleset are the same for every tool.

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

The interface goes in `src/gate/agents/agent.ts`, with one adapter per tool: `claude-code.ts`, `cursor.ts` and later `codex.ts`. They replace `SHELL_TOOL_NAMES` in `shared.ts`, and the `.claude/settings.json` reading in `hooks.ts` and `claude-settings.ts` ([#18](https://github.com/AbdulrahmanMasoud/comprende/issues/18)).

```ts
/** The AI tools the gate knows. */
export type AgentId = "claude-code" | "cursor" | "codex";

/** The environment a hook runs with, read-only. */
export type HookEnv = Readonly<Record<string, string | undefined>>;

/** One AI tool's hook input. Replies aren't here: a silent exit 0 allows, exit 2
 *  with stderr denies, and hookSpecificOutput.additionalContext adds session
 *  context, in every tool. The core builds them once. */
export interface Agent {
  /** For `--agent`, logs and messages. */
  readonly id: AgentId;

  /** Is this hook run from this tool? Needed only for the Claude-format command,
   *  which Claude Code and Cursor both run. `--agent` wins when it's given. Cursor
   *  is checked first (it sets CURSOR_VERSION), and Claude Code is the default. */
  detects(payload: unknown, env: HookEnv): boolean;

  /** The shell command about to run, validated at the edge, or null when the
   *  tool isn't this tool's shell ("Bash", "Shell"). */
  shellCommand(payload: unknown): string | null;

  /** The repo the hook is for: the payload's cwd, else this tool's project
   *  variable, else the process's own cwd. Cursor always sends cwd "". */
  projectDir(payload: unknown, env: HookEnv): string;

  /** This tool's repo-level hook files, most specific first. A copy of the hook
   *  steps aside when a more specific file already runs the gate. */
  readonly projectHookFiles: readonly ProjectHookFile[];
}

/** A repo-level hook file that `install` manages, such as .claude/settings.json. */
export interface ProjectHookFile {
  /** The path from the repo root. */
  readonly path: string;

  /** Does this content already run the gate? */
  runsGate(content: string): boolean;

  /** The content with the gate's hook added and every other entry kept, or null
   *  for a shape it doesn't understand (install then skips the file and says so).
   *  Pure: files.ts does the safe read and write. */
  withGateHook(existing: string | null): string | null;
}
```

How each tool fills it in:

| | Claude Code | Cursor | Codex (docs) |
|---|---|---|---|
| `detects` | the default | `CURSOR_VERSION` set, or `cursor_version` in the payload | only through `--agent codex` |
| Shell tool | `Bash` | `Shell` | `Bash` |
| `projectDir` | `cwd`, else `CLAUDE_PROJECT_DIR` | `CURSOR_PROJECT_DIR` (`CLAUDE_PROJECT_DIR` is the same path) | `cwd` |
| `projectHookFiles` | `.claude/settings.json` | `.cursor/hooks.json`, then `.claude/settings.json` | `.codex/hooks.json` |

The core also strips a leading UTF-8 BOM before parsing any payload. The hook command gets a neutral name, `agent-hook`. `claude-hook` stays as an alias, so repos that already have the hook keep working.

The platform adapter covers GitHub now and GitLab later ([#4](https://github.com/AbdulrahmanMasoud/comprende/issues/4)). It's the other half of #18: the CI workflow, CODEOWNERS, the PR's branch and labels, the reviewer summary, and `protect`.

### Step-aside rules

In Cursor, up to four copies of Comprende's hook can run on the same command:

| Copy | Format | Runs | Steps aside when |
|---|---|---|---|
| The repo's `.cursor/hooks.json` | Cursor | the repo's gate | never: it's the most specific |
| The repo's `.claude/settings.json` | Claude | the repo's gate | it runs in Cursor, and `.cursor/hooks.json` runs the gate |
| The native Cursor plugin (`hooks/cursor-hooks.json`) | Cursor | the plugin's gate | any repo hook file runs the gate |
| The imported Claude Code plugin (`hooks/hooks.json`) | Claude | the plugin's gate | any repo hook file runs the gate |

In a gated repo, exactly one copy checks. In a repo whose hook files were removed, both plugin copies check. That's harmless: each denies with the same reason, and Cursor joins the two messages.

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
        { "command": "node dist/gate.mjs session-start --agent cursor", "timeout": 30, "failClosed": false }
      ],
      "preToolUse": [
        { "matcher": "Shell", "command": "node dist/gate.mjs agent-hook --from-plugin --agent cursor", "timeout": 60, "failClosed": false }
      ]
    }
  }
  ```

  - **Relative paths:** plugin hooks run from the plugin's folder (tested), so there's no variable for PowerShell to misread.
  - **`failClosed: false`:** written out, because a hook may block only on a deliberate exit 2.
  - **Without `node`:** the shell exits with a code other than 2, so the hook fails open.
- **Shared as is:**
  - `skills/`, since Cursor reads `SKILL.md` and loads it by description.
  - The MCP server (`dist/server.mjs`, through `.mcp.json`). Whether Cursor reads `.mcp.json` through the manifest still needs a test.
- **No rule file.** The always-on line keeps coming from `sessionStart` (open question 4).

### What `gate.mjs install` writes for teammates on Cursor

**Recommendation:** also write `.cursor/hooks.json`, with a `preToolUse` hook (`matcher: "Shell"`) running `node .learning/gate.mjs agent-hook --agent cursor`. Don't rely only on Cursor importing `.claude/settings.json`.

- **It works with Third-Party Imports off.**
- **It works on Windows.** A relative `node` command runs in PowerShell and in `sh`, and project hooks run from the repo root (tested).
- **It runs once**, by the step-aside rules above.
- **It's protected like the other gate files.** `.cursor/hooks.json` joins `GATE_FILES` and CODEOWNERS.

**Upgrading:** a gate that predates this doesn't know `.cursor/hooks.json` is a gate file. So the exemption gets a feature in the gate's header (`cursor-hooks`), like the `.gitattributes` line in 0.2.1. Until the base branch runs a gate that lists it, the upgrade PR counts the new file as a change: one small-change question, or the skip label.

### Install steps for a Cursor user (after 0.3.0)

1. Install Node.js 20 or newer.
2. Install the plugin.
   - In the Cursor CLI, use `/plugin`. In the IDE, use Customize → Install, from the marketplace.
   - Without the marketplace, run `agent plugin marketplace add https://github.com/AbdulrahmanMasoud/comprende`.
   - If Comprende is already in Claude Code, Cursor imports it, so you can skip this step.
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

**An end-to-end script you can rerun,** `tools/cursor-e2e.mjs`, added in the Cursor adapter PR:
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

1. **The refactor, [#18](https://github.com/AbdulrahmanMasoud/comprende/issues/18), with no change in behavior,** in two PRs:
   - `chore:` split `setup.ts`, which is past 300 lines.
   - `refactor:` extract the Claude Code and GitHub adapters, plus a `cursor.ts` that only reads input. It takes over what 0.2.2 does with `Shell` and `cwd: ""`, so nothing regresses. Claude Code fixtures come with it.
2. **`feat:` the Cursor adapter (part of [#2](https://github.com/AbdulrahmanMasoud/comprende/issues/2)).** It brings:
   - `.cursor-plugin/` and `hooks/cursor-hooks.json`
   - `install` writing `.cursor/hooks.json`, behind the `cursor-hooks` feature
   - `agent-hook`, the BOM handling and the step-aside rules
   - the tests and the end-to-end script
   - the docs its changes touch: `docs/teams.md`, `docs/how-it-works.md`, `SECURITY.md` (the new gate file), and the CHANGELOG under Unreleased
3. **`docs:` the READMEs, then `chore:` release 0.3.0.**
   - Both READMEs, where Cursor is announced, and this page's status.
   - The release, on `chore/release-0.3.0`.

## Open questions

1. **Should `install` write `.cursor/hooks.json`?**
   - Benefit: it works with Third-Party Imports off, and on Windows.
   - Cost: a new gate file, and one question in each repo's upgrade PR until its base runs the new gate.
   - The alternative is to rely on Cursor importing `.claude/settings.json`.
2. **How do we distribute it?** Submit to the Cursor Marketplace (open source, reviewed, unknown wait), or ship first as a GitHub marketplace only (`agent plugin marketplace add`)?
3. **Someone with Comprende in both Claude Code and Cursor.** In Cursor, the skill shows up twice, and both plugins' hooks run. The hooks are fine: in a gated repo both step aside, and elsewhere a double deny is harmless. For the duplicate skill, do we just document "in Cursor, keep one: the Claude Code import or the Cursor plugin"? Or should the Cursor plugin leave out the skill when it finds Comprende in `~/.claude/plugins/installed_plugins.json`? That's possible, but it depends on a Claude Code file format we don't own.
4. **Where does the always-on line come from?** Keep it in `sessionStart`, as tested here? Or also ship an `alwaysApply` rule, which #2 first planned?
   - The rule is there from the first turn, even in the Agents window.
   - But it's a second copy of the text.
5. **Windows.** Can we ship Cursor support with Windows as "experimental"? That would mean:
   - not tested on Windows by us, and not in CI
   - documented as such, with problems tracked in #10
   - the git hook and CI still enforce
6. **Codex:** in the v0.3.0 milestone, or later? Each hook has to be trusted by hand first, which makes the first run less smooth.

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
