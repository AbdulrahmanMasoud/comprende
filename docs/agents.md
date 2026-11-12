# Comprende in other AI tools

Comprende runs in Claude Code, in Cursor from 0.3.0 ([#2](https://github.com/AbdulrahmanMasoud/comprende/issues/2)), and in Codex from 0.4.0 ([#3](https://github.com/AbdulrahmanMasoud/comprende/issues/3)). Start with [What works where](#what-works-where), what's weaker in [Cursor](#whats-weaker-in-cursor-than-in-claude-code) and in [Codex](#whats-weaker-in-codex-than-in-claude-code), and the checklists to try them by hand: [Cursor's IDE](#checking-it-in-the-cursor-ide) and [Codex](#checking-it-in-codex). The rest of the page is the research behind it, and the design for other tools on the same adapter interface ([#18](https://github.com/AbdulrahmanMasoud/comprende/issues/18)): Google Antigravity ([#25](https://github.com/AbdulrahmanMasoud/comprende/issues/25)), planned for 0.5.0.

- **Cursor:** tested on 2026-11-11 with the Cursor CLI (`cursor-agent`) `2026.11.10-731fb78` on macOS, plus the official docs.
- **Codex:** tested on 2026-11-11 with the Codex CLI `0.167.1` on macOS, plus the official docs and its source. See [Codex: what we found](#codex-what-we-found).
- **Antigravity:** from the official docs, plus the Antigravity CLI (`agy`) `1.5.5` on macOS: first without a sign-in, then signed in, for Step 0 on 2026-11-12 ([recording](recordings/antigravity/)). See [Antigravity: what we found](#antigravity-what-we-found).

Each answer is marked with its source:
- **Tested:** confirmed by our own run of the tool (see [How we tested](#how-we-tested)).
- **Docs:** from official documentation, linked. Forum links are posts by the tool's staff, unless marked as a third party.
- **Source:** read in the tool's own source code at a release tag, linked. Used only where the docs are silent.
- **Unknown:** none of these. The row says why, and how much it matters.

A few Cursor rows also lean on reading the CLI's bundled JavaScript, and say so.

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
- **On Windows, Cursor runs hooks in PowerShell.** Claude Code's `sh` hook commands fail open there. Since 0.3.0, Cursor's own hooks are plain `node` lines. See [Windows](#windows).

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
| Commit attribution | The agent adds `Co-authored-by: Cursor <cursoragent@cursor.com>` to the commits it makes. The setting is `attribution.attributeCommitsToAgent`, on by default. Contributors who use it must turn it off, because of our no-attribution rule | Tested (the trailer, in the end-to-end run). Docs: [CLI configuration](https://cursor.com/docs/cli/reference/configuration) (the setting) |
| `sessionStart` in the Agents window | Staff say the context arrives after the first request. That matters for the always-on line (decision 4) | Unknown (IDE only). Docs: [forum](https://forum.cursor.com/t/174143) |

### Windows

The docs say: "the desktop app runs hook commands through PowerShell and pipes the JSON into the command" ([hooks](https://cursor.com/docs/hooks)). The 2026.11.10 CLI's bundled JavaScript builds hook commands as PowerShell too. Staff say the CLI switches to Git Bash when it sees Git Bash's environment (`MSYSTEM`), and that it once sent stdin with a UTF-8 BOM ([forum](https://forum.cursor.com/t/168129), [forum](https://forum.cursor.com/t/166794)).

**Unknown by test, because we have no Windows machine with Cursor.** It matters a lot, since many Cursor users are on Windows:

- **Claude Code's hook commands are POSIX `sh`:** `command -v node … || exit 0; exec node "$CLAUDE_PROJECT_DIR/…"`, in `.claude/settings.json` and the Claude Code plugin. PowerShell can't run them. They fail with an exit code other than 2, so they fail open: nothing breaks, but those copies check nothing.
- **The git pre-push hook still works,** because git runs hooks through its own `sh`.
- **Cursor's own hooks, since 0.3.0, are plain `node` lines,** in the Cursor plugin and the repo's `.cursor/hooks.json`. These run in both shells (tested in `pwsh` in CI, not on Windows). The gate strips a BOM before parsing a payload.

- **And PowerShell hides the block:** with `-Command`, it turns a program's exit 2 into 1, unless the command ends with `exit $LASTEXITCODE`. So even a hook that runs can't block a push by exit code there. Tested in `pwsh` in CI, in [#50](https://github.com/AbdulrahmanMasoud/comprende/pull/50).

Windows as a whole is tracked in [#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10).

## What works where

| | Claude Code | Cursor (0.3.0) | Codex (0.4.0) | Antigravity (0.5.0) |
|---|---|---|---|---|
| The skill (explain as you build) | yes | yes, the same `skills/` (tested in the CLI) | yes, the same `skills/` (tested in the CLI) | yes, the same `skills/` (tested in the CLI) |
| Memory (the MCP server) | yes | yes, all 10 tools, once the server is approved (tested in the CLI) | yes, all 10 tools, from its own MCP config (tested in the CLI) | yes, all 10 tools, from its own `mcp_config.json`. In a headless run, each tool needs an allow rule (tested in the CLI, one call) |
| The always-on line | at session start | at session start, from the plugin's `sessionStart` hook (tested in the CLI) | at session start, once the plugin's hooks are trusted in `/hooks` (tested in the CLI). After an update, the repo's session start says they need trusting again (tested in the CLI) | the instruction from the plugin's rule, `rules/AGENTS.md`, and a session-start line that the hooks run (tested in the CLI) |
| The push guard (the agent's `git push`) | the plugin, or the repo's `.claude/settings.json` | the plugin, or the repo's `.cursor/hooks.json`. Also `.claude/settings.json` and an imported Claude Code plugin, while Third-Party Imports is on (tested in the CLI) | the plugin, or the repo's `.codex/hooks.json`, each once trusted. The repo's keeps its trust across updates (tested in the CLI) | the plugin only: a JSON deny (tested in the CLI). No repo hook file, which would run alongside the plugin's |
| The git `pre-push` hook | installed by the plugin at session start | the same (tested in unit tests, not in the CLI run) | the same, once the hooks are trusted (tested in the CLI) | installed by the plugin at session start, as in the other tools (not tested in Antigravity) |
| CI | the same check: it doesn't depend on the tool | the same | the same | the same |
| Windows | experimental: hooks run in Git Bash | experimental: hooks run in PowerShell, which turns a block's exit 2 into 1, so the push guard fails open (tested in `pwsh` in CI, not on Windows; [#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10)) | the same as Cursor | experimental: which shell runs hooks isn't documented. The hook commands exit 0 in `cmd.exe` and both PowerShells, and check nothing there (tested in CI, not in Antigravity) |

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
- **Cursor's agent signs its commits.** It adds `Co-authored-by: Cursor <cursoragent@cursor.com>` to the commits it makes. Turn off `attribution.attributeCommitsToAgent` if you don't want it.

## What's weaker in Codex than in Claude Code

- **Hooks need trust.** Codex runs no plugin hook until it's trusted in `/hooks`, and again after every plugin update: it checks the plugin's whole folder. Until then it skips the hooks without a word, so the agent's push isn't checked by the hook (the git hook and CI still check it). The repo's `.codex/hooks.json` keeps its trust across updates, and in a gated repo its session start then tells the agent to say so (tested in the CLI).
- **Project hooks need the project trusted too.** Each developer trusts the project once, then the repo's two hooks.
- **Codex's `workspace-write` sandbox keeps `.git` read-only,** so the agent asks before it commits.
- **The repo's hook needs a common shell.** Codex runs it with your `$SHELL`: it works in sh, bash, zsh, fish 3.4+ and PowerShell. In tcsh or nu that copy fails open, and the plugin's hook still checks.
- **Two plugin copies** (the Codex plugin, and a Claude Code copy brought over by `/import`) check a push once, but give the session lines twice. Install it once ([Codex: the design](#codex-the-design)).
- **Windows:** PowerShell turns a block's exit 2 into 1, so the guard fails open there ([#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10)).
- **The commit trailer** depends on a setting of the account, which Codex has no config key for. None was added in our runs.

## Checking it in Codex

`tools/e2e-codex.mjs` covers the CLI headless. Check these by hand, in a gated demo repo (the README's "Try it in 5 minutes"), in the CLI and in the IDE extension (OpenAI's extension for VS Code and Cursor, which runs the same `codex` with the same `~/.codex`):

1. **Install:** `codex plugin marketplace add AbdulrahmanMasoud/comprende`, then `codex plugin add comprende@comprende`.
2. **Trust:** open Codex in the demo, trust the project, then type `/hooks` and trust Comprende's two hooks, and the two in the repo's `.codex/hooks.json`.
3. **Memory:** `/mcp` lists **comprende** with its 10 tools.
4. **Session start:** start a session, and ask what Comprende said at session start. Expect the always-on line and the gate's message.
5. **An ordinary command:** ask it to run `ls`. It runs, with no hook message.
6. **The push guard:** ask it to add `sum(xs)` to `math.js`, commit and push. The push is blocked with "Ask Codex to run the ownership check".
7. **Check me:** say "check me", answer, and write a summary. The report is saved and committed, then a separate push goes through.
8. **After an update:** `codex plugin marketplace upgrade comprende`, then start a session and ask for a small code change. The agent says the hooks need trusting again. Trust them in `/hooks`, and the next session's note is back.

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

## Codex: what we found

Tested on 2026-11-11 with the Codex CLI `0.167.1` on macOS, signed in with ChatGPT, plus the official docs and, where they're silent, Codex's source at the [`rust-v0.167.1`](https://github.com/openai/codex/tree/rust-v0.167.1) tag. The captures are in [`test/fixtures/codex/`](../test/fixtures/codex/).

### Comprende 0.3.0 in Codex, before Codex support

Codex installs today's Comprende as it is: it reads `.claude-plugin/marketplace.json` as a marketplace, and `.claude-plugin/plugin.json` as the plugin. All tested, in a gated demo repo:

| | Hooks not trusted yet (the default) | Hooks trusted in `/hooks` |
|---|---|---|
| The skill | loads (`comprende:comprende`) | loads. Explain-as-you-build worked: one short sentence on the non-obvious part, and the agent held the commit for the ownership check |
| The session-start message | no: no hook runs | arrives: the always-on line and the gate's message, quoted back word for word. The git hook gets installed |
| An ordinary command (`ls`) | runs | runs, and the hook is silent |
| The agent's unverified `git push` | **goes through**: nothing checks it | blocked, but by the git hook. Codex's hook steps aside, see below |
| The memory server | doesn't start | doesn't start |

Nothing is broken for users: no command is blocked by mistake, and CI still checks every PR. But in Codex today:

- **The plugin's hook steps aside wrongly.** Codex's payload is Claude Code's shape, so the gate reads it as Claude Code. Claude Code always runs the repo's `.claude/settings.json`, which every gated repo has, so the plugin steps aside for it. Codex never runs that file. Fed the captured payload, the plugin's gate exits 0 with the file, and blocks without it, with "Ask Claude to run the ownership check".
- **Hooks are skipped after every update,** with no message. Codex checks plugin hooks against a hash of the whole plugin folder. One file added to the installed plugin, and the next session ran no Comprende hook; removed, and it ran again.
- **The memory server never starts.** Codex doesn't expand `${CLAUDE_PLUGIN_ROOT}` in a plugin's `.mcp.json`, so Node gets that literal path and exits. Codex reports "MCP startup failed: handshaking with MCP server failed: connection closed".

### Hooks

| Question | Answer | Source |
|---|---|---|
| Events | `SessionStart`, `SessionEnd`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreModelRequest`, `PostModelRequest`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt` | Docs: [hooks](https://learn.chatgpt.com/docs/hooks) |
| Where | `hooks.json`, or `[hooks]` in `config.toml`, in `~/.codex/` (user) or `<repo>/.codex/` (project), plus a plugin's `hooks/hooks.json`. All of them run | Tested (user, project and plugin hooks all ran on the same events). Docs: [hooks](https://learn.chatgpt.com/docs/hooks) |
| A feature flag | None needed: `hooks` is on by default (`codex features list` shows it stable and on). `codex_hooks` is a deprecated alias | Tested. Docs: [hooks](https://learn.chatgpt.com/docs/hooks) |
| Trust | Each hook must be trusted once, by hash, in `/hooks`. An untrusted hook is skipped silently, also in `codex exec`. Project hooks also need the project trusted. Installing a plugin doesn't trust its hooks. A plugin's hooks are rechecked against a hash of the plugin's whole folder, so any change, such as an update, skips them until they're trusted again | Tested (untrusted: no run; trusted: ran; one file added to the plugin: no run; removed: ran). Docs: [hooks](https://learn.chatgpt.com/docs/hooks), [plugins](https://developers.openai.com/plugins/build/plugins). Source: [`plugin_trust.rs`](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/hooks/src/engine/plugin_trust.rs) |
| Session-start input | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `source` (`startup`, `resume`, `clear`, `compact` or `fork`) | Tested ([`session-start.json`](../test/fixtures/codex/session-start.json)) |
| Shell input | Claude Code's shape, plus `turn_id` and `model`: `tool_name: "Bash"`, `tool_input: { command }`, `cwd`, `session_id`, `tool_use_id` (`exec-<uuid>`). Claude Code sends neither `turn_id` nor `model` | Tested ([`pre-tool-use.bash.git-push.json`](../test/fixtures/codex/pre-tool-use.bash.git-push.json)) |
| Working folder | The payload's `cwd` is the command's own folder. The hook process runs in the session's folder | Source, for the split; we only saw both be the repo: [`pre_tool_use.rs`](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/hooks/src/events/pre_tool_use.rs) |
| Environment | Plugin hooks get `PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CODEX_HOME`. A `${VAR}` in a hook command is replaced as text | Tested ([`hook-env.json`](../test/fixtures/codex/hook-env.json)). Docs: [hooks](https://learn.chatgpt.com/docs/hooks) |
| What blocks | Exit 2 with the reason on stderr, which is the gate's default reply. Also `hookSpecificOutput.permissionDecision: "deny"`, or the older `{"decision": "block"}`. The agent sees the reason | Tested (all three) |
| What doesn't block | Exit 2 with empty stderr, exit 1, plain stdout, invalid JSON, and Antigravity's `{"decision": "deny"}`: the command runs | Tested |
| Empty stdout | Allows, silently | Tested |
| Session context | `hookSpecificOutput.additionalContext` reaches the agent. Plain stdout does too, per the docs | Tested (Comprende's own message). Docs: [hooks](https://learn.chatgpt.com/docs/hooks) |
| Timeout | 600 seconds by default | Docs: [hooks](https://learn.chatgpt.com/docs/hooks) |

### Other tools' files, and plugins

| Question | Answer | Source |
|---|---|---|
| `.claude/settings.json`, `.cursor/hooks.json` | Not run. In a gated repo that has both, `hooks/list` showed only the plugin's hooks. `/import` copies hooks, MCP servers, skills and plugins from Claude Code or Cursor, once | Tested. Docs: [import](https://learn.chatgpt.com/docs/import) |
| Claude Code plugins | Installed as they are. `codex plugin marketplace add <this repo>` read `.claude-plugin/marketplace.json`, and `codex plugin add comprende@comprende` installed 0.3.0 from `.claude-plugin/plugin.json`, with `skills/`, `hooks/hooks.json` and `.mcp.json` | Tested (a local copy of this repo). Docs: [plugins](https://developers.openai.com/plugins/build/plugins) ("legacy and Claude-compatible manifests") |
| Which manifest wins | `.codex-plugin/plugin.json`, then `.claude-plugin/plugin.json`, then `.cursor-plugin/plugin.json`. The first one found is used. The docs also describe a root `plugin.json`, in the Agent Plugins format | Source: [`protocol.rs`](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/exec-server-protocol/src/protocol.rs). Tested (it used `.claude-plugin/`). Docs: [plugins](https://developers.openai.com/plugins/build/plugins) |
| Manifest fields | `name`, `version`, `description`, `skills`, `mcpServers`, `apps`, `hooks`, `interface`. The defaults are `skills/`, `hooks/hooks.json` and `.mcp.json`, and paths start with `./` | Docs: [plugins](https://developers.openai.com/plugins/build/plugins). Source: [`manifest.rs`](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/core-plugins/src/manifest.rs), [`loader.rs`](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/core-plugins/src/loader.rs) |
| Install from GitHub | `codex plugin marketplace add AbdulrahmanMasoud/comprende` (`--ref` for a branch or tag), then `codex plugin add comprende@comprende`, or `/plugins` in the TUI. `codex plugin marketplace upgrade` refreshes a Git marketplace | Tested (with a local path). Docs: [plugins](https://developers.openai.com/plugins/build/plugins), [CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) |
| The plugin-root variable | `${PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` in hook commands. In MCP config, only `${PLUGIN_ROOT}` in an Agent Plugins `mcp.json`. A relative `cwd` resolves against the plugin's folder | Tested (hooks). Source: [`agent_plugin_config.rs`](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/codex-mcp/src/agent_plugin_config.rs) (MCP) |
| Sharing `skills/` | Yes, as is | Tested |
| Sharing the MCP server | Not with today's `.mcp.json`: see above | Tested |

### Skills, MCP and the CLI

| Question | Answer | Source |
|---|---|---|
| Where skills are found | The repo's `.agents/skills` and `.codex/skills`, `~/.agents/skills`, `$CODEX_HOME/skills`, and plugins' skills. Not `.claude/skills` or `.cursor/skills` | Tested (`codex debug prompt-input`, which shows what the model would get without calling it). Docs: [skills](https://learn.chatgpt.com/docs/build-skills) |
| Loaded automatically | Yes, when the request matches the description | Docs: [skills](https://learn.chatgpt.com/docs/build-skills). Tested (explain-as-you-build) |
| MCP config | `[mcp_servers.<name>]` in `config.toml`, with `command`, `args`, `env`, `cwd` or `url`. A plugin can bring its own | Docs: [MCP](https://learn.chatgpt.com/docs/extend/mcp) |
| Headless runs | `codex exec --json -C <dir> -s workspace-write --add-dir <dir> -o <last-message-file> "<prompt>"`, and `codex exec resume <id>`. `-c key=value` overrides config. `codex exec` reads stdin when it isn't a terminal, so close it | Tested. Docs: [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) |
| The sandbox | `workspace-write` keeps `.git` read-only. `--add-dir <repo>/.git` let the agent commit | Tested |
| Trust in headless runs | `--dangerously-bypass-hook-trust` skips trust for one run. We trusted the hooks the way `/hooks` does instead: the app server's `hooks/list` gives each hook's key and hash, and `config/batchWrite` stores `hooks.state.<key>.trusted_hash` | Tested. Source: [`hooks_rpc.rs`](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/tui/src/hooks_rpc.rs) |
| Config folder | `CODEX_HOME`, default `~/.codex`. It must exist already | Tested. Docs: [environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables) |
| Sign-in | `codex login` (ChatGPT in the browser), `--device-auth`, or `--with-api-key`. Credentials are in `$CODEX_HOME/auth.json`, or the OS keyring | Docs: [auth](https://learn.chatgpt.com/docs/auth) |
| Install | `npm install -g @openai/codex`, `brew install --cask codex`, or `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | Docs: [CLI](https://learn.chatgpt.com/docs/codex/cli). We used the npm package, installed into a scratch folder |

### Windows and commits

| Question | Answer | Source |
|---|---|---|
| The shell for hooks | The session's shell: PowerShell (`-NoProfile -Command`) on Windows, `$SHELL -c` elsewhere. A hook can set `commandWindows` | Unknown by test. Source: [`command_runner.rs`](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/hooks/src/engine/command_runner.rs). Docs: [hooks](https://learn.chatgpt.com/docs/hooks) (`commandWindows`) |
| A trailer on the agent's commits | None on our test commit. The source adds an instruction to write `Co-authored-by: Codex <noreply@openai.com>` when a server-side account setting is on, never with an API key. There's no config key to turn it off in 0.167.1 | Tested (one commit, ChatGPT sign-in). Source: [`git-attribution`](https://github.com/openai/codex/tree/rust-v0.167.1/codex-rs/ext/git-attribution) |

## Antigravity: what we found

From the official docs (read on 2026-11-11), and the Antigravity CLI (`agy`) `1.5.5` on macOS, in a throwaway `HOME`. Everything that needs the model needs a Google sign-in. Step 0 was the first signed-in run, on 2026-11-12: Comprende 0.4.2 as `agy plugin install` converts it, before any Antigravity support ([recording](recordings/antigravity/)). What it didn't cover stays Unknown, for a later signed-in run. The claims from the outside PR ([#16](https://github.com/AbdulrahmanMasoud/comprende/pull/16), listed in [#25](https://github.com/AbdulrahmanMasoud/comprende/issues/25)) are checked at the end.

Antigravity is three products: the App, the IDE, and the CLI (`agy`). The CLI is the only one we can drive from a script.

### Comprende 0.4.2 in Antigravity (Step 0)

`agy plugin install <this repo>` converts Comprende by itself, since it's a Claude Code plugin: "1 skill, 1 MCP server, 2 hooks" (tested). In the converted `hooks.json`, `matcher: "Bash"` became `run_command`, and `${CLAUDE_PLUGIN_ROOT}` became `./`, since plugin hooks run in the plugin's folder. Step 0 ran 0.4.2 that way, signed in and headless ([recording](recordings/antigravity/)):

- **The shell hook runs on every command and replies with nothing, and Antigravity doesn't block on that.** The hook calls the gate with no `--agent`, so the gate reads the payload as Claude Code's, finds no `tool_name`, and allows: exit 0, nothing on stdout. The command then goes on to Antigravity's own permission check, as it does without Comprende (tested).
- **It can't check a push,** for the same reason. In a gated repo, git's `pre-push` hook still blocks it (tested), and CI still checks.
- **Any non-zero exit blocks the command** (tested, with exit 1 and exit 2, from test hooks in `~/.gemini/config/hooks.json`). The plugin's hooks go through the same runner (Antigravity names both `jsonhook__<group>_<event>_…`), so they're taken to behave the same. The gate's hook commands exit 1 when they fail (`FAIL_OPEN_EXIT` in `cli.ts`), which is "skip this hook" in Claude Code. So in Antigravity, a crash, or a Node.js that can't load `gate.mjs`, would block every command. No step hit it: on this payload, the gate allows before it does any work.
- **The session start finds the repo, and its reply is rejected.** The payload has `cwd`, so the gate printed the always-on line and the ownership-gate note (`mode: required`). The reply is in Claude Code's shape, and Antigravity rejects it: `unknown field "hookSpecificOutput"`, in its own log only. The agent gets nothing (tested).
- **The memory server starts:** Antigravity cached a schema for each of its 10 tools (tested). No step called one.

### Comprende 0.4.3 in Antigravity

0.4.3 gives Antigravity its own plugin files, so a failed hook no longer blocks the command ([recording](recordings/antigravity/#the-043-fix-a-failed-hook-lets-the-command-run)):

- **`.antigravity-plugin/plugin.json`, a root `hooks.json` and a root `mcp_config.json`.** Only Antigravity reads them. With its own manifest, `agy plugin install` takes the plugin as it is (`Source: antigravity`) and stops converting the Claude Code one. Without the manifest, the conversion writes its own `hooks.json` over a root one (tested). The manifest also stops the conversion of `.mcp.json`, hence `mcp_config.json`.
- **Each hook command holds the gate's output in the shell, with no `&&` or `||`:**

  ```sh
  set "A=$(node "$PLUGIN_ROOT/dist/gate.mjs" … --from-plugin; printf 'x%s' "$?")$(exit 0)"; held=${1#A=}; code=${held##*x}; ok=${code%%[1-9]*}; reply=${held%x*}; printf '%s' "${ok:+$reply}"; exit 0
  ```

  - **In `sh`,** it holds the gate's output with `x` and its exit code at the end (`$(exit 0)` expands to nothing there), and prints the output, `reply`, only when that code is 0. Anything else exits 0 with nothing on stdout: `node` missing (exit 127), `gate.mjs` missing, a crash, exit 2 (tested, each case). The shell does it, not `node`, so it holds when `node` can't run. `node … || exit 0` alone isn't enough: a crash's partial output would go out, and non-JSON stdout on exit 0 blocks too (tested). The `A=` keeps an output that starts with `-` from being read as an option of `set`.
  - **The gate's path is `$PLUGIN_ROOT/dist/gate.mjs`,** which Antigravity sets for plugin hooks. So the plugin's own gate runs, whatever folder a product runs hooks in: the CLI runs them in the plugin's folder (tested), and the IDE's and App's folder is Unknown. Without `PLUGIN_ROOT` (CLI versions before 1.5.3), no gate runs, and the command exits 0.
  - **Antigravity runs hooks with `sh` on macOS,** even when `$SHELL` is zsh (tested). The tests also run the command in `bash`, `dash` and `zsh`.
  - **The rules that keep it safe in other shells,** checked by a test on every PR: no `&&` or `||` (Windows PowerShell 5.1 can't parse them, and PowerShell 7 stops the chain at a command it doesn't know); `set "A=` first, with no `&`, `|`, `<`, `>` or `^` outside `cmd.exe`'s quote pairs; `$(exit 0)` closing the first statement's string; and no `${…}` inside another, which PowerShell can't parse.
- **The commands run the same gate entry points as before,** `session-start --from-plugin` and `claude-hook --from-plugin`, with no `--agent`. So 0.4.3 still can't check a push in Antigravity: git's `pre-push` hook and CI do (tested). The adapter comes in 0.5.0.
- **Every path is the plugin's own.** Hooks run `$PLUGIN_ROOT/dist/gate.mjs`, and the MCP server starts from `${PLUGIN_ROOT}/dist/server.mjs`. In a repo with its own `dist/gate.mjs` and `dist/server.mjs`, neither ran (tested, with marker files). A `gate_status` call through the MCP server worked (tested).
- **Upgrading:** `agy plugin install https://github.com/AbdulrahmanMasoud/comprende` again. It replaces a converted install ("replaced existing installation", tested). Whether `agy plugin import claude` reads `.antigravity-plugin/` is Unknown, so a copy imported that way should be installed again with `agy plugin install`.
- **What it can't fix:** a hook that outlives its timeout is killed, and that blocks the command (tested, with a test hook). No wrapper helps, since the shell itself is killed. In 0.4.3 the gate allows Antigravity's payload before doing any work.
- **No logo yet.** The icon is in `.claude-plugin/`, and Antigravity's Marketplace bundle leaves out dot-folders. Without it, `agy plugin validate` warns only that `.mcp.json` and `hooks/hooks.json` are never loaded, which is right: they're Claude Code's.
- **Windows:** which shell Antigravity runs hooks in there isn't documented, and its Windows build names both `cmd.exe` and PowerShell. So the command has no `&&` or `||`, and it exits 0 with nothing on stdout in `cmd.exe`, PowerShell 7 and Windows PowerShell 5.1, with or without `node` (tested in the Windows workflow, not in Antigravity). In `cmd.exe` it's one `set "A=…"` and the gate doesn't run, also when quoted the way Go's `os/exec` quotes an argument. In PowerShell, `$PLUGIN_ROOT` is an unset PowerShell variable, so no gate runs, and `$(exit 0)` ends the script with 0. So on Windows, 0.4.3's hooks never block, and never check either: git's `pre-push` hook and CI do. The converted command before 0.4.3 used `||`, which Windows PowerShell 5.1 can't parse, so if Antigravity runs hooks there, that one failed on every command.

### Comprende 0.5.0 in Antigravity

0.5.0 gives Antigravity its own adapter, `src/gate/agents/antigravity.ts` ([Antigravity: the design](#antigravity-the-design), [recording](recordings/antigravity/#050-the-adapter)):

- **The push check works.** The plugin's hook passes `--agent antigravity`, the gate reads `toolCall.args.CommandLine`, and an unverified push gets a JSON deny on exit 0. Antigravity blocks the command and the agent sees the reason, `tool call denied by pre-tool hook: Blocked by the ownership gate: …`. Git's `pre-push` hook never ran: the push didn't start (tested). Any other command gets an empty allow (tested).
- **The gate's note reaches the agent,** as `injectSteps` with a system message, which Antigravity shows the agent as "injected by a SessionStart hook" (tested). Outside a gated repo, it sends only the line that says the hooks run (tested).
- **The always-on instruction comes from a plugin rule,** `rules/AGENTS.md`, which Antigravity loads whenever the plugin is enabled, hooks or not. The rule leaves out the words "Comprende is installed": the skill reads them as "the hooks ran", and a rule also loads where hooks don't run (Windows, maybe the IDE, `agy` before 1.5.3). So the session start sends only `Comprende is installed, and its hooks run in this session.`, and the agent gets the instruction once. That's only for our own hook file, which passes `--agent antigravity`: a copy converted from the Claude Code plugin may come without the rule, so it gets the full line. With `COMPRENDE_QUIET=1`, the session start sends the quiet line, and the rule still loads; which one the agent follows is untested.
- **No `.agents/hooks.json`:** a repo file would run the gate a second time on every command (tested). See [Antigravity: the design](#antigravity-the-design).
- **The hook commands** stay 0.4.3's, so a failed gate still lets the command run, in every shell.

### Hooks

| Question | Answer | Source |
|---|---|---|
| Events | `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop` | Docs: [hooks](https://antigravity.google/docs/hooks/) |
| Where | The project's `.agents/hooks.json`, the user's `~/.gemini/config/hooks.json`, and a plugin's `hooks.json` at its root. Not `hooks/hooks.json`. A plugin's root `hooks.json` counts only when the plugin has its own manifest: for a Claude Code plugin, `agy plugin install` writes the converted hooks over it. Project hooks need the workspace trusted, per the docs. In a headless run, a repo's `.agents/hooks.json` ran with no trust step, in the `.agents/` folder, and alongside the plugin's hooks on the same events | Docs: [hooks](https://antigravity.google/docs/hooks/), [changelog](https://antigravity.google/docs/changelog/) ("a hooks/hooks.json file (which isn't read)"). Tested (0.4.3: the root `hooks.json`. 0.5.0: `.agents/hooks.json`) |
| The file's shape | Named groups: `{"<group>": {"PreToolUse": [{"matcher": "run_command", "hooks": [{"type": "command", "command": "…", "timeout": 30}]}]}}`. `SessionStart` takes a flat list. Each hook has an `enabled` key | Docs: [build plugins](https://antigravity.google/docs/build-plugins/). Tested (the converted plugin's `hooks.json`) |
| Input on stdin | camelCase. Both events we saw (`SessionStart`, `PreToolUse`) have `hookEventName`, `conversationId`, `cwd`, `workspacePaths` (a list), `transcriptPath`, `artifactDirectoryPath`, `modelName` and `lastUserInput`. `PreToolUse` adds `stepIdx` and `toolCall: {id, name, args}`. For `run_command`, `args` held `CommandLine`, `WaitMsBeforeAsync` and `toolSummary`. The docs also list `Cwd`, which the agent didn't set in our runs. The docs don't list `cwd`, `hookEventName` or `toolCall.id` | Tested (Step 0). Docs: [hooks](https://antigravity.google/docs/hooks/) |
| The reply | Exit 0, and a JSON object on stdout with `decision`: `allow`, `auto_approve`, `deny`, `ask`, `force_ask` or `deny_unless_prior_grant`, plus an optional `reason`. `{"decision": "deny", "reason": …}` blocks the command, and the agent sees `tool call denied by pre-tool hook: <reason>`. `{"decision": "allow"}` doesn't skip Antigravity's own permission check: it means the same as an empty reply. `auto_approve` would skip it, so the gate never sends it | Docs: [hooks](https://antigravity.google/docs/hooks/), [build plugins](https://antigravity.google/docs/build-plugins/). Tested (0.5.0: `deny` and `allow`) |
| Exit codes | Any non-zero exit blocks the tool call: exit 1 and exit 2 both ended it with "JSON hook … failed: command failed: exit status N", and the command didn't run. The docs say a non-zero exit is "logged as a hook execution error and ignored (failing open)". It isn't, in `agy` 1.5.5 | Tested (Step 0, with test hooks in `~/.gemini/config/hooks.json`). Docs: [build plugins](https://antigravity.google/docs/build-plugins/) |
| Empty or non-JSON stdout | Empty stdout on exit 0 doesn't block: the command goes on to the permission check. A `SessionStart` reply with a field Antigravity doesn't know is rejected whole (strict parsing), logged as failed, and ignored. So a reply must carry no extra fields. Non-JSON stdout on exit 0 from `PreToolUse` blocks the command: `failed to unmarshal result … invalid value`. Not documented: the changelog only mentions "safely handling empty decision strings" | Tested (Step 0: empty, and the session start. 0.4.3: non-JSON, with a test hook) |
| Session context | `injectSteps`. The two pages differ: `[{"userMessage": "…"}]` on one, and "the same schema as PreInvocation" (`systemMessage`) on the other. Claude Code's `hookSpecificOutput` is rejected: `unknown field "hookSpecificOutput"`, in Antigravity's log only, and the agent gets nothing. All three `injectSteps` shapes reach the agent, each as a different step: `{"systemMessage": {"systemMessage": …}}` as a system message "injected by a SessionStart hook", `{"userMessage": …}` as a request from the user, and `{"ephemeralMessage": …}` as a transient message. The gate uses the system message | Tested (Step 0: `hookSpecificOutput`. 0.5.0: the three shapes). Docs: [build plugins](https://antigravity.google/docs/build-plugins/), [hooks](https://antigravity.google/docs/hooks/) |
| Plugin hooks' folder and environment | They run in the plugin's folder, with `PLUGIN_ROOT`, `PLUGIN_DATA` and `ANTIGRAVITY_CONVERSATION_ID` set. The changelog says CLI 1.5.3 added the first two | Tested (Step 0). Docs: [build plugins](https://antigravity.google/docs/build-plugins/), [changelog](https://antigravity.google/docs/changelog/) |
| A feature flag | None. Project hooks, skills and MCP servers need the workspace trusted | Docs: [hooks](https://antigravity.google/docs/hooks/), [changelog](https://antigravity.google/docs/changelog/) |
| Timeout | 30 seconds by default, per hook. A hook that outlives it is killed, and that blocks the command: `command failed: signal: killed` | Docs: [hooks](https://antigravity.google/docs/hooks/). Tested (0.4.3, with a test hook) |
| In the IDE | Disputed. A forum user says hooks run only in the CLI (IDE 2.1.1, App 2.5.0, August 2026). Later App releases fix hooks. The IDE's changelog never mentions hooks | Third party: [forum](https://discuss.ai.google.dev/t/do-antigravity-ide-2-0-actually-execute-plugin-hooks-pretooluse-posttooluse-or-is-that-cli-only-right-now/176814). Docs: [changelog](https://antigravity.google/docs/changelog/). Unknown: we can't drive the IDE |

### Plugins

| Question | Answer | Source |
|---|---|---|
| Manifest | `plugin.json` at the plugin root, or in `.antigravity-plugin/`, which wins, "for multi-provider repositories that also ship .claude-plugin/plugin.json or .cursor-plugin/plugin.json". `.gemini-plugin/` works too | Docs: [build plugins](https://antigravity.google/docs/build-plugins/), [customization discovery](https://antigravity.google/docs/customization-discovery/). Tested (`agy plugin validate` names all three) |
| Fields | `name` (the only required one), `displayName`, `description`, `version`, `logo` (a square image of 128px or more, inside the plugin), `suggestedPrompts`, `skills`, `disabled`, `author`, `homepage`, `repository`, `license`, `keywords`, `extensions`, and `$schema`, which the docs' examples use. Unknown fields are rejected | Docs: [build plugins](https://antigravity.google/docs/build-plugins/). Tested (`$schema`: install and validate accept it) |
| Components | At the plugin root: `skills/`, `mcp_config.json`, `agents/`, `rules/` and `hooks.json`. The manifest can't point elsewhere | Docs: [build plugins](https://antigravity.google/docs/build-plugins/) |
| The plugin-root variable | `${PLUGIN_ROOT}` in MCP `args`, `cwd` and `env`. Hooks should use relative paths (`node ./dist/gate.mjs`), since they run in the plugin's folder | Docs: [build plugins](https://antigravity.google/docs/build-plugins/) |
| Install | `agy plugin install https://github.com/<owner>/<repo>`, or a local folder. It lands in `~/.gemini/config/plugins/<name>`, which is "replaced when the plugin updates". A plugin folder in the project's `.agents/plugins/` works too. No App screen installs from GitHub. Running it again replaces the installed copy, a converted one included ("replaced existing installation"). Installed clients notice an update by the manifest's `version` | Tested (a local copy of this repo, and installing over a converted copy). Docs: [plugins](https://antigravity.google/docs/plugins/), [build plugins](https://antigravity.google/docs/build-plugins/) (the `version` field) |
| Claude Code plugins | `agy plugin install` converts one (tested, above), unless it has its own Antigravity manifest. The conversion writes its own `plugin.json`, `hooks.json` and `mcp_config.json` at the root, over any already there. `agy plugin import claude` imports those in `~/.claude/plugins/`, once | Tested (install, and a root `hooks.json` written over). Docs: [plugins](https://antigravity.google/docs/plugins/) (import) |
| This repo, validated | Before 0.4.3, `agy plugin validate` failed: "no plugin.json found at the plugin root or in .antigravity-plugin or .gemini-plugin. This looks like a Claude Code plugin: `plugin install` converts it, but it doesn't load as is". From 0.4.3 it passes, warning that `.mcp.json` and `hooks/hooks.json` are never loaded, which is right: they're Claude Code's. A logo in a dot-folder gets a warning of its own, since the Marketplace bundle leaves dot-folders out | Tested |
| Sharing `skills/` | Yes, if each skill's `name` matches its folder (`skills/comprende/` and `name: comprende` do). Plugin skills are named `<plugin>:<skill>` | Docs: [build plugins](https://antigravity.google/docs/build-plugins/). Tested (the conversion kept it) |
| Sharing the MCP server | It needs its own `mcp_config.json`: `.mcp.json` is read only by an import | Docs: [build plugins](https://antigravity.google/docs/build-plugins/) |

### Skills, rules, MCP and the CLI

| Question | Answer | Source |
|---|---|---|
| Where skills are found | `.agents/skills/` (and the older `.agent/skills/`), `~/.gemini/config/skills/`, and plugins' `skills/`. Gemini CLI's `.gemini/skills/` has to be moved. The plugin's skill loaded on a code change: the agent read its `SKILL.md` first | Docs: [skills](https://antigravity.google/docs/skills/), [Gemini CLI migration](https://antigravity.google/docs/cli/gcli-migration/). Tested (0.5.0: the plugin's skill) |
| Loaded automatically | Yes: "If a skill looks relevant to your task, the agent reads the full SKILL.md" | Docs: [skills](https://antigravity.google/docs/skills/) |
| Always-on rules | `AGENTS.md` or `GEMINI.md`, `.agents/rules/*.md` with a `trigger`, and a plugin's `rules/AGENTS.md`, "loaded automatically as an always-on rule whenever the plugin is enabled". A plugin's rule reached the agent, which named it as a rule | Docs: [rules](https://antigravity.google/docs/rules/), [build plugins](https://antigravity.google/docs/build-plugins/). Tested (0.5.0) |
| MCP config | `~/.gemini/config/mcp_config.json`, the project's `.agents/mcp_config.json`, or a plugin's own `mcp_config.json`, named `<plugin>_<server>`. The converted plugin's server started, and Antigravity cached a schema for each of its 10 tools, as `comprende_comprende`. 0.4.3's own `mcp_config.json`, with `${PLUGIN_ROOT}/dist/server.mjs`, started the plugin's server, and a `gate_status` call worked | Docs: [MCP](https://antigravity.google/docs/mcp/). Tested (Step 0: the tools cached. 0.4.3: one call) |
| Headless runs | `agy -p "<prompt>" --output-format json\|stream-json`, `--dangerously-skip-permissions`, `--add-dir`, `--print-timeout`. The workspace is the folder it starts in. An action that needs approval is soft-denied: the run goes on and exits 0. A shell command needs approval unless an allow rule matches it, such as `--settings '{"permissions":{"allow":["command(ls)"]}}'` for one run. An MCP tool's rule is `mcp(<server>/<tool>)`, such as `mcp(comprende_comprende/gate_status)` | Tested (Step 0, 0.4.3). Docs: [headless](https://antigravity.google/docs/cli/headless/) (the soft deny) |
| A config-folder override | None: it uses `HOME` | Tested (a throwaway `HOME` worked). Docs: [CLI reference](https://antigravity.google/docs/cli/reference/) (none listed) |
| Sign-in | Google OAuth in the browser. The CLI prints the link and waits 60 seconds, for the browser to hand the sign-in back or for the code to be pasted in. It takes a pasted code only on a terminal: with stdin from a pipe, it stops with "authentication required". A code works only in the run that asked for it (PKCE). The token goes to the OS keyring: on macOS, the login keychain, so a throwaway `HOME` needs its own. A Gemini API key works only with `modelProvider: "gemini"` | Tested (Step 0). Docs: [install](https://antigravity.google/docs/install/) |
| Install | The App and IDE: a `.dmg`. The CLI: `curl -fsSL https://antigravity.google/cli/install.sh \| bash` (to `~/.local/bin/agy`, or `--dir <folder>`). It checks the download's SHA-512 and updates itself | Tested (the script read, then run with a throwaway `HOME` and `--dir`). Docs: [getting started](https://antigravity.google/docs/getting-started/) |

### Windows and commits

| Question | Answer | Source |
|---|---|---|
| The shell for hooks | Not documented. The CLI's status-line command runs through `sh -c`, or `cmd /c` on Windows. On macOS, the converted commands' `sh` syntax ran (`command -v node … || exit 0; exec node …`). The Windows build's binary (`1.5.6`) contains both `cmd.exe`, through `COMSPEC`, and `powershell -NoProfile -Command`, so which one runs hooks there is still Unknown. 0.4.3's commands exit 0 in `cmd.exe` and both PowerShells | Tested on macOS: `sh`, even when `$SHELL` is zsh (0.4.3). Windows: Unknown; 0.4.3's commands tested in the Windows workflow, not in Antigravity. Docs: [settings](https://antigravity.google/docs/settings/) (the status line only). The Windows build's strings |
| A trailer on the agent's commits | Not documented. One forum user saw commits authored by "antigravity", through a Zed extension | Unknown. Third party: [forum](https://discuss.ai.google.dev/t/gemini-antigravity-git-commits-with-random-author-via-zed-extension/185955) |

### The outside PR's claims (#16)

| Claim | Verdict |
|---|---|
| The plugin folder: `plugin.json`, `mcp_config.json`, `hooks.json`, `rules/`, `skills/` | Confirmed by the docs, with two corrections. In a repo that also has `.claude-plugin/`, the manifest goes in `.antigravity-plugin/`. And the MCP server's path should use `${PLUGIN_ROOT}`: a relative `args` with `cwd: "."` isn't documented |
| Named groups in `hooks.json`, with commands relative to the plugin (`node ./dist/gate.mjs …`) | Confirmed by the docs, and by the converted plugin (tested) |
| The shell tool is `run_command`, the command is `toolCall.args.CommandLine`, the workspace is `workspacePaths[0]` | The first two confirmed by the docs and by Step 0. The third is an assumption: `workspacePaths` can hold several folders. The payload also has `cwd` (Step 0) |
| Replies are JSON decisions, not exit codes | Half right. A decision is JSON on exit 0, but a non-zero exit blocks the command (Step 0), though the docs say it fails open |
| Session context through `injectSteps` with `systemMessage.systemMessage` | Documented on the hooks page. The build-plugins page shows `userMessage` instead. Unknown which works |

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

**The two optional methods** are there for tools that reply in JSON. Antigravity wants `{"decision": "deny", "reason": …}` and `injectSteps`, and blocks on any non-zero exit. Such a tool fits without touching the interface.

**One command, two names.** The hook command is `agent-hook`, and `claude-hook` stays its alias, because existing `.claude/settings.json` files and the plugin's `hooks/hooks.json` call it.

How each tool fills it in:

| | Claude Code | Cursor | Codex | Antigravity |
|---|---|---|---|---|
| `detects` | any payload: the fallback | `cursor_version` in the payload, or the tool name `Shell`. Not the environment: Claude Code started from Cursor's terminal may inherit Cursor's variables | `turn_id` in a tool call's payload, and `--agent codex` in its hook files | a string `conversationId` and `hookEventName`, and `--agent antigravity` in its hook file |
| Shell tool | `Bash` | `Shell` | `Bash` | `run_command`, command in `toolCall.args.CommandLine` |
| `projectDir` | `cwd`, else `CLAUDE_PROJECT_DIR`, else its own folder (Claude Code runs hooks from the project) | the one entry in `workspace_roots` (`cwd` is `""`), else `CURSOR_PROJECT_DIR` or `CLAUDE_PROJECT_DIR`, else step aside: Cursor runs plugin hooks from the plugin's folder. With several roots it steps aside, since it can't tell which one the command runs in | `cwd`, the command's folder | `toolCall.args.Cwd`, resolved against `cwd` when relative, else the payload's `cwd`. Either must be absolute, else step aside |
| `names` | Claude, Claude Code | Cursor, Cursor | Codex, Codex | Antigravity, Antigravity |
| `pluginUpdateHint` | `/plugin marketplace update comprende` | the same, since Cursor may be running the Claude Code plugin it imported, or `git -C ~/.cursor/plugins/local/comprende pull` for its own copy | `codex plugin marketplace upgrade comprende`, then trust the hooks again in `/hooks` | `agy plugin install` again (tested over a converted copy) |
| `projectHookFiles` | `.claude/settings.json`, always run | `.cursor/hooks.json`, always run, then `.claude/settings.json`, run only while Third-Party Imports is on | `.codex/hooks.json`, run only once the project and the hook are trusted | none: a repo's `.agents/hooks.json` would run alongside the plugin's hooks |
| `eventId` | the tool call's id; none for a session, since one session runs one plugin copy | the tool call's id, or the session's | `tool_use_id`, or `session_id` | `toolCall.id`, or `conversationId` |
| `formatDecision` | the default | the default | the default (tested) | nothing to allow, `{"decision": "deny", "reason": …}` on exit 0 to block (tested) |
| `formatSessionContext` | the default | the default | the default (tested) | `injectSteps` with a system message, or `{}` (tested) |

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
   - On Windows, in PowerShell: `git clone https://github.com/AbdulrahmanMasoud/comprende.git "$HOME\.cursor\plugins\local\comprende"`. PowerShell 5.1 and cmd don't expand `~` for `git`.
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

### Codex: the design

**It fits the `Agent` interface as it is.** Codex sends Claude Code's payload shape, blocks on exit 2 with stderr, and reads `hookSpecificOutput.additionalContext`, so the core's default replies work (tested). The adapter, `src/gate/agents/codex.ts`:

| Member | Codex |
|---|---|
| `detects` | `turn_id`, which only Codex sends, on a tool call. Not `model`: Claude Code's session start sends it too ([hooks](https://code.claude.com/docs/en/hooks)). So a Codex session start without `--agent` is read as Claude Code's, and its notes name Claude Code. Our own hook files pass `--agent codex`, which wins. In `AGENTS`, Codex comes after Cursor and before Claude Code, which detects everything |
| `shellCommand` | `tool_input.command` when `tool_name` is `Bash`, read by `claude-format.ts` |
| `projectDir` | the payload's `cwd`, which is the command's folder |
| `names` | Codex, Codex |
| `pluginUpdateHint` | `codex plugin marketplace upgrade comprende`, then trust the hooks again in `/hooks`. Tested: the upgrade also updates the installed plugin (0.2.3 to 0.3.0, from this repo on GitHub) |
| `projectHookFiles` | `.codex/hooks.json`, with `alwaysRuns: false`: Codex runs it only once the project and each hook are trusted |
| `eventId` | the tool call's `tool_use_id`, or the session's `session_id` |
| `formatDecision`, `formatSessionContext` | the defaults |

**The files to add:**
- **`.codex-plugin/plugin.json`:** the same `skills/`, its own hooks file and MCP config. Codex reads it before `.claude-plugin/`, and neither Claude Code nor Cursor reads it.
- **`hooks/codex-hooks.json`,** in Codex's format, which is Claude Code's:
  - `SessionStart`: `node "${PLUGIN_ROOT}/dist/gate.mjs" session-start --from-plugin --agent codex`
  - `PreToolUse`, `matcher: "Bash"`: `node "${PLUGIN_ROOT}/dist/gate.mjs" agent-hook --from-plugin --agent codex`
  - plain `node` lines, since Codex runs hooks in PowerShell on Windows. Without `node`, the command fails with an exit code other than 2, and Codex lets the tool run.
- **A Codex MCP config,** `.codex-plugin/mcp.json`, that starts the server. `${CLAUDE_PLUGIN_ROOT}` isn't expanded there, but a relative `cwd` resolves against the plugin's folder: `"command": "node", "args": ["dist/server.mjs"], "cwd": "."`. Tested: Codex's app server lists all 10 tools, with no sign-in needed.

**What `install` writes for teammates on Codex:** `.codex/hooks.json`, behind a `codex-hooks` feature, like `.cursor/hooks.json` (decided, and built in 0.4.0). Its pros and cons:
- **For:**
  - It works without the plugin.
  - It doesn't go untrusted when Comprende updates. Codex checks a project hook against its own declaration; only plugin hooks are checked against the whole folder. Tested: after `.learning/gate.mjs` changed, the hook stayed trusted; after its command changed, it was "modified".
- **Against:**
  - Each developer has to trust the project, and then each hook, once.
  - Codex runs hooks in the session's folder, which may be a subfolder. So the command can't be a plain relative path: it's `node "$(git rev-parse --show-toplevel)/.learning/gate.mjs" agent-hook --agent codex`, and `$(…)` works in PowerShell too, so it needs no `commandWindows`. Tested: from a subfolder it blocks an unverified push, and without `git` or `node` it fails open.
  - The shell hook, and since 0.4.1 a session start: its trust lasts across plugin updates, so after one it still runs, and tells the agent the plugin isn't running. See below.

**No double runs:**
- The plugin and `.codex/hooks.json` both run when both are trusted. Neither can count on the other, so both claim the `tool_use_id`, and only the first checks.
- **Session start comes from both, each line once.** Unlike Cursor's `.cursor/hooks.json`, `.codex/hooks.json` isn't sure to run (`alwaysRuns: false`), so the plugin never steps aside for it. The plugin gives the always-on line, the repo's file gives Codex's note for when the plugin isn't running (`pluginNotRunningHint`: not installed, or its hooks skipped; one line for both, since the note can't tell which), and both claim the gate's message under one key, so it comes once.
- **A known limit: two plugin copies in one Codex session.** `/import` from Claude Code can bring over Claude Code's copy of Comprende as a second plugin. For a push, both copies detect Codex from `turn_id` and claim the tool call, so it's checked once. A session start has no `turn_id`, so the Claude Code copy reads it as Claude Code's and claims nothing: the always-on line and the gate's message come twice, one naming Claude Code. And its always-on line hides the repo's note when the Codex plugin isn't running. Install it in one place. The matrix test asserts the counts.
- The matrix test gains a Codex column, trusted and not.

**The user's install steps:**
1. `codex plugin marketplace add AbdulrahmanMasoud/comprende`
2. `codex plugin add comprende@comprende`
3. In Codex, open `/hooks` and trust Comprende's two hooks. Do it again after every update.

**What's weaker than in Claude Code:**
- **Hooks need trust,** after the install and after every update, and Codex skips them without a word until then. The git hook and CI still check. So does `.codex/hooks.json`, if it's written and trusted.
- **Codex's `workspace-write` sandbox keeps `.git` read-only,** so the agent asks before it commits.
- **On Windows, a block doesn't reach Codex as exit 2.** Codex runs hooks in PowerShell with `-Command`, which turns a program's exit 2 into 1 unless the command ends with `exit $LASTEXITCODE`. So the push guard fails open there, and the git hook and CI still check. Tested in `pwsh` in CI. Cursor, which also runs hooks in PowerShell on Windows, has the same limit. The fix, a JSON deny that doesn't depend on exit codes, needs a Windows run: [#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10).
- **The repo's `.codex/hooks.json` needs a common shell.** Its `$(git rev-parse …)` works in sh, bash, zsh, fish 3.4+ and PowerShell. With another `$SHELL` (tcsh, nu) that copy fails open, and the plugin's hook still checks.
- **The commit trailer** depends on an account setting that Codex has no config key for.
- **Windows is untested.**

**The end-to-end script, `tools/e2e-codex.mjs`,** like `tools/e2e-cursor.mjs`:
- A throwaway `CODEX_HOME` with a copied `auth.json`, or `CODEX_API_KEY`.
- `codex plugin marketplace add` and `codex plugin add` with this repo.
- It trusts the hooks the way `/hooks` does: the app server's `hooks/list`, then `config/batchWrite`.
- Each turn is `codex exec --json -o <reply> "<prompt>"` from the demo's folder, or `codex exec … resume <session>` for the next one, with stdin closed. `exec resume` takes no sandbox flags, so the sandbox goes through config: `-c sandbox_mode="workspace-write"` and `-c sandbox_workspace_write.writable_roots=[<demo>/.git, <origin.git>]`.
- **The steps:**
  - session start
  - `ls`, with the hook silent
  - an unverified push, blocked by Codex's hook: the script counts the `gate.mjs` runs that exit 2, as `tools/e2e-cursor.mjs` does. Removing the git hook doesn't last, since each turn's session start installs it again
  - "check me", through to a separate push that goes through
  - the memory server
  - explain-as-you-build
  - one file changed in the installed plugin: the hooks are skipped, and the script says so
  - the plugin plus `.codex/hooks.json`: one check
  - BLOCKED at a usage limit, as in Cursor

### Antigravity: the design

Built in 0.5.0 ([recording](recordings/antigravity/#050-the-adapter)): the adapter, `src/gate/agents/antigravity.ts`, as below. What the real runs changed is said in each row.

**It fits the `Agent` interface's methods as they are,** with the two optional ones, since a deny is JSON on exit 0. Two things change around them:
- **`AgentId` gains `"antigravity"`,** as it gains `"codex"`.
- **The rule "a hook blocks only on a deliberate exit 2"** (CLAUDE.md, SECURITY.md, the comment on `HookReply` in `types.ts`) becomes "a hook blocks only on a deliberate deny". In Antigravity, a deny is exit 0 with `{"decision": "deny"}`. A test checks that only a deny decision prints a deny.

The adapter, `src/gate/agents/antigravity.ts`:

| Member | Antigravity |
|---|---|
| `detects` | a string `conversationId` and `hookEventName`, which only Antigravity sends (camelCase). Our own hook file passes `--agent antigravity`. A converted Claude Code copy of the plugin, which passes no `--agent`, is detected too, so both copies claim the same tool call |
| `shellCommand` | `toolCall.args.CommandLine` when `toolCall.name` is `run_command` |
| `projectDir` | `toolCall.args.Cwd` for a command, when the agent sets one, resolved against `cwd` when it's relative. Otherwise the payload's `cwd` (Step 0 found it). Without an absolute one, step aside: a wrong repo would mean a deny that isn't a verdict on the push. Never the process's folder: plugin hooks run in the plugin's |
| `names` | Antigravity, Antigravity |
| `pluginUpdateHint` | `agy plugin install https://github.com/AbdulrahmanMasoud/comprende` again (the update flow isn't documented; to confirm) |
| `projectHookFiles` | none (see `.agents/hooks.json`, below) |
| `eventId` | `toolCall.id`, which Step 0 found though the docs don't list it. The session's `conversationId` |
| `formatDecision` | exit 0, with nothing to allow, and `{"decision": "deny", "reason": "…"}` to block. Nothing, not `{"decision": "allow"}`: both mean the same (tested), and nothing is what every path that can't format a reply prints |
| `formatSessionContext` | `{"injectSteps": [{"systemMessage": {"systemMessage": "…"}}]}`, or `{}` with nothing to say. With no extra fields: Antigravity rejects a reply with one it doesn't know (Step 0). And `alwaysOnFromRule`: the plugin's `rules/AGENTS.md` brings the always-on instruction, so the session start from our own hook file only says the hooks ran |

**One change in the core,** not in the interface (0.5.0). When stdin isn't JSON, `readHookInput` still resolves `--agent`, so Antigravity's hooks answer in its own format, never in Claude Code's, which Antigravity would reject. A crash inside `agentHook` already replies in the adapter's format, from its `catch`. A crash outside it, in `cli.ts`, exits 1 with nothing on stdout, and Antigravity blocks on any non-zero exit (Step 0). So Antigravity's hook commands must always exit 0, a crash included. A deny is JSON on exit 0.

**The files:** 0.4.3 added the first three, to stop a failed hook from blocking ([Comprende 0.4.3 in Antigravity](#comprende-043-in-antigravity)). 0.5.0 passes `--agent antigravity` in their commands, and adds a rule.
- **`.antigravity-plugin/plugin.json`:**
  - `name`, `displayName`, `description`, `version`, `author`, `homepage`, `repository`, `license`, `keywords`. A `logo` once the icon is outside a dot-folder
  - Antigravity reads it before a root `plugin.json`, and Codex doesn't read it.
  - Codex does read a root `plugin.json` (Agent Plugins), so we don't add one.
- **A root `hooks.json`:** Antigravity reads a plugin's hooks only there.
  - `SessionStart`: 0.4.3's command, with `session-start --from-plugin --agent antigravity`
  - `PreToolUse`, `matcher: "run_command"`: the same with `agent-hook`
  - Relative paths, since hooks run in the plugin's folder.
  - The shell holds the gate's output and exits 0 whenever the gate fails, as 0.4.3's commands do. A deny is JSON on exit 0, so it still goes out.
- **A root `mcp_config.json`:** `node` with `${PLUGIN_ROOT}/dist/server.mjs`.
- **`rules/AGENTS.md`,** the always-on instruction, word for word, without the words "Comprende is installed" (a test checks both). Antigravity loads it whenever the plugin is enabled, hooks or not. Cursor discovers a plugin's `rules/` too, unless its manifest sets `rules`, but it applies a rule automatically only with `alwaysApply: true` frontmatter, which this file has none of. `tools/e2e-cursor.mjs` checks that the instruction comes once in Cursor.
- **Claude Code and Codex read none of these.** `agy plugin validate` warns about our `hooks/hooks.json` ("isn't read"), which is only an error with `--strict`.

**What `install` writes for teammates on Antigravity: nothing.** A repo's `.agents/hooks.json` would be read, with no trust step in a headless run, but it runs alongside the plugin's hooks on the same events, in the `.agents/` folder (tested). So every command would run the gate twice, and a teammate without the plugin would get no always-on line either, which comes from the plugin's rule. The plugin's hooks, git's `pre-push` hook and CI cover a push. Decided in 0.5.0: a repo file only if a run shows it doesn't double-run with the plugin, and this one does.

**No double runs:**
- There's no repo hook file, so only plugin copies can meet. A copy converted from the Claude Code plugin by `agy plugin import claude` passes no `--agent`, is detected from the payload, and claims the same keys as the plugin's own hooks: `toolCall.id` for a push, `conversationId` for a session. So a push is checked once, and the session's lines come once (tested, with the gate alone). A known limit: when the converted copy speaks first, it sends the full always-on line, so with the plugin's rule loaded the instruction comes twice (tested). Whether the import carries the plugin's `rules/` is untested.
- `agy plugin install` of this repo no longer converts it: it has its own manifest (0.4.3).
- Two plugins named `comprende` can't both be installed in Antigravity's plugin folder (to confirm).

**The user's install steps:**
1. `curl -fsSL https://antigravity.google/cli/install.sh | bash`, or the App.
2. `agy plugin install https://github.com/AbdulrahmanMasoud/comprende`
3. Open a gated repo, and trust the workspace.

**What's weaker than in Claude Code:**
- **Any non-zero exit blocks, and a deny must be JSON.** So the adapter can't lean on the core's default, and a failure must still exit 0.
- **Hooks may not run in the IDE** (disputed). The git hook and CI still check.
- **The plugin's files sit at the repo's root.**
- **The tool-call id isn't documented,** though the payload has one (`toolCall.id`, Step 0).
- **There's no config-folder override,** so tests need a throwaway `HOME`.
- **A hook that times out blocks the command,** and no wrapper can stop it. The gate's work must stay well inside the timeout.
- **The shell on Windows isn't documented.** The hook commands are written to exit 0 in `cmd.exe` and both PowerShells, but they check nothing there.
- **An update replaces the installed folder,** and how it's triggered isn't documented.

**The end-to-end script, [`tools/e2e-antigravity.mjs`](../tools/e2e-antigravity.mjs) (0.5.0).** How to run it: CONTRIBUTING.md, [Testing in Antigravity](../CONTRIBUTING.md#testing-in-antigravity).
- A throwaway `HOME`, signed in first, with its own keychain on macOS: the token goes to the login keychain, and a pasted code works only on a terminal (Step 0).
- `agy plugin install` of a copy of this repo's plugin files, and a check that `agy plugin list` finds Antigravity's own manifest: 1 skill, 1 rule, 1 MCP server, 1 hook.
- Each turn is `agy -p "<prompt>" --output-format stream-json` in the demo, with only the allow rules its step needs in `--settings`. Not `--dangerously-skip-permissions`: what the agent may run stays part of the test.
- The steps: session start (the hook's one system message, read from the log, and the rule's instruction once, from the agent's quotes), an ordinary command, an unverified push denied by the hook, "check me" through to a push that goes through, the memory server, every hook running the installed plugin's `gate.mjs` and never the repo's, and explain-as-you-build with the skill loaded. Not Codex's after-update, repo-hook or commit-trailer steps: Antigravity has no hook trust to lose on an update, and no repo hook file, and its agent's commits in the script's runs had no trailer.
- The App and the IDE stay manual, with a checklist like Cursor's.

### The order of PRs

**0.3.0, done:**

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
3. **`chore:` release 0.3.0, with the docs,** on `chore/release-0.3.0`, as the maintainer asked: both READMEs, where Cursor is announced, this page's status, and the release itself.

**0.4.0, proposed.** Codex first: it's tested, and today's Comprende already installs there, with its hook stepping aside wrongly.

1. **`feat/codex-adapter`** (part of #3): `src/gate/agents/codex.ts`, before Claude Code in `AGENTS`, with tests from `test/fixtures/codex/`. With it, a Codex payload is no longer read as Claude Code's, so the hook stops stepping aside for `.claude/settings.json`, and messages say "Codex".
2. **`feat/codex-plugin`:**
   - `.codex-plugin/plugin.json`, `hooks/codex-hooks.json`, and an MCP config that starts in Codex
   - `tools/release.mjs` and the Consistency job keep its version in step
   - the update hint, with the re-trust step
3. **`feat/codex-install`:**
   - `install` writes `.codex/hooks.json` (if decided), behind `codex-hooks`
   - the matrix test gains Codex
   - `tools/e2e-codex.mjs`
4. **`feat/antigravity-adapter`** (part of #25):
   - `src/gate/agents/antigravity.ts`, with `formatDecision` and `formatSessionContext`
   - the core resolves `--agent` when stdin isn't JSON (done)
   - fixtures from a signed-in run, in `test/fixtures/antigravity/`
5. **`feat/antigravity-plugin`:**
   - 0.4.3 added `.antigravity-plugin/plugin.json`, the root `hooks.json` and `mcp_config.json`, and the version in `VERSION_FIELDS`. 0.5.0 passes `--agent antigravity`, and adds `rules/AGENTS.md`
   - `tools/e2e-antigravity.mjs`
6. **`feat/antigravity-install`:** dropped. `install` writes no `.agents/hooks.json` (decided in 0.5.0).
7. **`chore/release-0.4.0`,** with the docs:
   - the READMEs, this page's "What works where", `docs/teams.md` and `SECURITY.md` (the new hook files, and trust in Codex)
   - the CHANGELOG
   - every version file, now including `.codex-plugin/` and `.antigravity-plugin/`

## Decisions

The maintainer settled the open questions on 2026-11-11:

1. **`install` writes `.cursor/hooks.json` too.**
   - Its commands need no POSIX shell: `node .learning/gate.mjs <cmd> --agent cursor`. So they work in PowerShell on Windows, and a missing `node` fails open.
   - A repo with both `.claude/settings.json` and `.cursor/hooks.json` runs the gate once in Cursor. `projectHookFiles` decides who steps aside.
2. **The Cursor Marketplace comes after 0.3.0** has shipped from GitHub and passed a manual check in the IDE.
3. **The skill loaded twice:** for now, document "install it in one place".
4. **The always-on line stays in `sessionStart`.** There's no `alwaysApply` rule. The Cursor plugin's hook commands avoid shell syntax too.
5. **Windows ships as "experimental" for Cursor**, tracked in [#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10).
6. **Release plan,** updated on 2026-11-11: 0.3.0 is Cursor. 0.4.0 is Codex ([#3](https://github.com/AbdulrahmanMasoud/comprende/issues/3)), 0.5.0 is Google Antigravity ([#25](https://github.com/AbdulrahmanMasoud/comprende/issues/25)), and 0.6.0 is GitLab ([#4](https://github.com/AbdulrahmanMasoud/comprende/issues/4)). Antigravity got its own release, since it needs a signed-in run first.

### Open questions for 0.4.0

1. **Codex: should `install` write `.codex/hooks.json`?** Decided: yes, and built in 0.4.0. It survives plugin updates and works without the plugin. But each developer trusts the project and the hooks once, and the command needs `git rev-parse` to find the gate from a subfolder.
2. **Codex: re-trusting after every update.** There's no way around it short of `--dangerously-bypass-hook-trust`, which is for automation, not users. The plugin's session start can't say so, since its hooks are the ones skipped. The skill loads without trust, so proposal: the skill and the README say "after an update, trust Comprende's hooks again in `/hooks`". Decided: yes, and the skill now says so when a gated repo's session got no session-start note. In 0.4.0 that never fired in Codex: the agent searched for `.learning/config.json` with `rg --files`, which skips hidden folders, so it didn't open the skill. With the skill loading for any code change, a rerun failed the same way: Codex listed the new description, but its agent didn't open the skill for a small edit. So the note now comes from the repo's `.codex/hooks.json`, whose session start keeps its trust across plugin updates. Found since: `codex plugin marketplace upgrade` updates the installed plugin too (tested). Still to find out: whether the MCP server needs approval again after an update.
3. **Antigravity: plugin files at this repo's root.** Decided: yes, with a consistency test. A `hooks.json` and an `mcp_config.json` (0.4.3), and a `rules/` folder (0.5.0): Antigravity reads them only there.
4. **Antigravity: the always-on line from a plugin rule** (`rules/AGENTS.md`) instead of `SessionStart`? Decided: yes, with no duplication (0.5.0), except when a converted copy of the plugin speaks first (see "No double runs"). A rule doesn't depend on hooks running, which is disputed in the IDE.
5. **Antigravity: the CLI first?** Decided: yes. The IDE gets a checklist to try by hand. We can test only the CLI, and the IDE may not run hooks.
6. **Antigravity: should `install` write `.agents/hooks.json`?** Decided: no. It runs alongside the plugin's hooks (tested), so the gate would run twice on every command.
7. **One release or two?** Decided: 0.4.0 is Codex, 0.5.0 Antigravity, 0.6.0 GitLab.

**What the signed-in Antigravity runs had to answer,** for the adapter. Step 0's, 0.4.3's and 0.5.0's runs answered five:
- **What an empty stdout does:** answered, it doesn't block (Step 0). It mattered for safety: every path that can't format a reply prints nothing, such as an unknown `--agent` passed to an older repo copy of `gate.mjs`.
- **Whether `stepIdx` is unique per tool call:** no longer needed. Claims can key on `toolCall.id`, which the payload has (Step 0).
- **Which `injectSteps` shape reaches the agent:** answered, all three, as different kinds of step. The gate uses the system message (0.5.0's runs).
- When the agent sets `toolCall.args.Cwd`, and whether it's an absolute path.
- **Which folder project hooks run in:** answered, the `.agents/` folder (0.5.0's runs).
- **Whether a hook that times out blocks:** answered, it does (0.4.3's runs).
- Whether `--dangerously-skip-permissions` skips hooks too.

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

**Codex**, with the Codex CLI `0.167.1`:
- **Installed** from npm (`@openai/codex`) into a scratch folder, and run with a throwaway `HOME` and `CODEX_HOME`. The maintainer's ChatGPT sign-in was copied into it, for these runs only.
- **The probe repo:**
  - user and project hooks that recorded their stdin and environment, then answered each command in one reply style, with one command blocked on purpose per style
  - a silent allow path
  - a skill in each of `.agents/skills`, `.codex/skills`, `.claude/skills`, `.cursor/skills`, `~/.agents/skills` and `$CODEX_HOME/skills`
- **Comprende itself:** 0.3.0, installed with `codex plugin marketplace add` and `codex plugin add` from a local copy of this repo, in the gated demo repo, with hooks first untrusted, then trusted. A `NODE_OPTIONS=--import` preload logged each `gate.mjs` run.
- **Trust,** done the way Codex's own prompts do it, through the app server: `config/batchWrite` of `projects.<path>.trust_level = "trusted"` for the probe project, and `hooks/list`, then `config/batchWrite` of each hook's `trusted_hash`, as `/hooks` does. The `--dangerously-bypass-hook-trust` flag wasn't used.
- **The captures:** in [`test/fixtures/codex/`](../test/fixtures/codex/), with personal data removed.

**Antigravity**, with the CLI `agy` `1.5.5`:
- **Installed** with the official script, read first, then run with a throwaway `HOME` and `--dir` in a scratch folder.
- **Without a sign-in:**
  - `agy --help` and `agy plugin validate` on this repo
  - `agy plugin install` of a local copy of this repo, which converts it
  - the converted hooks run the way Antigravity runs them, on payloads built from the docs' fields
- **Signed in (Step 0, 2026-11-12):** the gated demo and a repo without the gate, with 0.4.2 installed by `agy plugin install`, headless, with the gate's runs logged. Plus test hooks in `~/.gemini/config/hooks.json` that exit 1 and 2. See the [recording](recordings/antigravity/). The preload and the driver aren't committed, so Step 0 can't be repeated as is until `tools/e2e-antigravity.mjs` exists.
- **The Windows build** (`1.5.6`): downloaded from the manifest the install script reads, its SHA-512 checked, and only its strings read, for the shell it might run hooks in.
- **Signed in (0.4.3, 2026-11-12):** the fix's own plugin files, with `node` missing, `gate.mjs` missing, a crash after partial output, decoy `dist/` files in the repo, a push and an MCP call. Plus test hooks for non-JSON stdout and a timeout. See the [recording](recordings/antigravity/).
- **Signed in (0.5.0, 2026-11-12):** test hooks for each `injectSteps` shape, a JSON deny and a JSON allow, a repo's `.agents/hooks.json`, a probe plugin with a rule, and the skill on a code change. Then the adapter itself: the session context in a gated repo and a plain one, an unverified push, and `ls`. See the [recording](recordings/antigravity/#050-the-adapter).
- **Still to run signed in:** whether `--dangerously-skip-permissions` skips hooks, and when the agent sets `toolCall.args.Cwd`.
- **The docs:** each key quote was also checked against the page's own text.
