# Comprende in other AI tools

Comprende runs in Claude Code. This page collects what we know about running it in other tools, starting with Cursor ([#2](https://github.com/AbdulrahmanMasoud/comprende/issues/2)), and proposes a design. Nothing here has shipped, except the fix in 0.2.2 noted below.

- **Cursor:** tested on 2026-11-11 with the Cursor CLI (`cursor-agent`) `2026.11.10-731fb78` on macOS, plus the official docs.
- **Codex:** from its docs only, to check that the design fits a third tool.

Each answer is marked with its source:
- **Tested:** confirmed by a run of `cursor-agent` (see [How we tested](#how-we-tested)).
- **Docs:** from official documentation, linked. Forum links are posts by Cursor staff.
- **Unknown:** neither. The row says why, and how much it matters.

## The short version

- **Cursor already runs Comprende's Claude Code hooks.** It runs the repo's `.claude/settings.json` and the hooks of the Claude Code plugins you've installed.
  - It sends them its own payload. The shell tool is called `Shell`, and `cwd` is `""`.
  - Until 0.2.2, the gate's hook therefore let every push through in Cursor ([#17](https://github.com/AbdulrahmanMasoud/comprende/issues/17)). 0.2.2 fixes it.
- **The session-start message reaches the agent in Cursor.** So does the reason for a block.
- **Skills load from `.cursor/skills`, `.claude/skills` and `.agents/skills`.** They load automatically when a request matches the description.
- **What breaks a hook in Cursor:** any stdout that isn't JSON blocks the command, even on exit 0. Empty stdout is fine.
- **On Windows, Cursor runs hooks in PowerShell, according to the docs.** Our hook commands are POSIX `sh`, so there they would fail open. That means no agent-side push check on Windows. This is untested.

## Cursor: what we found

### Hooks (`.cursor/hooks.json`)

| Question | Answer | Source |
|---|---|---|
| Events | `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `subagentStart`, `subagentStop`, `afterAgentResponse`, `afterAgentThought`, `workspaceOpen`, plus Tab's `beforeTabFileRead` and `afterTabFileEdit` | Docs: [hooks](https://cursor.com/docs/hooks) |
| `sessionStart` input | `conversation_id`, `generation_id`, `session_id` (all three the same), `model`, `is_background_agent`, `hook_event_name: "sessionStart"`, `cursor_version`, `workspace_roots`, `user_email`, `transcript_path` (`null`). There's no `cwd`. The docs also list `composer_mode`, which the CLI didn't send. See [`session-start.json`](../test/fixtures/cursor/session-start.json) | Tested |
| `preToolUse` input for the shell | `tool_name: "Shell"`, `tool_input: { command, cwd: "", timeout }`, `tool_use_id`, `cwd: ""`, plus the common fields. See [`pre-tool-use.shell.git-push.json`](../test/fixtures/cursor/pre-tool-use.shell.git-push.json) | Tested |
| `preToolUse` for another tool | Read: `tool_name: "Read"`, `tool_input: { file_path }`. See [`pre-tool-use.read.json`](../test/fixtures/cursor/pre-tool-use.read.json) | Tested |
| `beforeShellExecution` input | `command`, `cwd: ""`, `sandbox: false`, `tool_use_id` (the same as `preToolUse`'s), plus the common fields | Tested |
| Order | `preToolUse` runs first. When it denies, `beforeShellExecution` doesn't run | Tested |
| Permission output | `{"permission": "allow" \| "deny" \| "ask", "user_message", "agent_message"}`. `ask` isn't enforced for `preToolUse` | Tested (allow, deny). Docs: [hooks](https://cursor.com/docs/hooks) (`ask`) |
| What the agent sees on a deny | `user_message`, inside the tool's rejection: `Command execution was blocked by a hook: <user_message>`. `agent_message` never reached the agent, for `preToolUse` or `beforeShellExecution`. What the IDE shows the person is unknown (IDE only), and it matters little: exit 2 with stderr works everywhere | Tested (CLI) |
| Exit 0, empty stdout | Allowed | Tested |
| Exit 0, stdout that isn't JSON | Blocked: `Hook "…" returned invalid JSON. The command was blocked for safety.` | Tested |
| Exit 2 | Blocked, the same as `permission: "deny"` | Tested (see the Claude-format rows below). Docs: [hooks](https://cursor.com/docs/hooks) |
| Exit 1 (a crash) | Allowed. Hooks fail open | Tested |
| `failClosed` | Per hook, default `false`. When `true`, a crash, timeout or missing output blocks | Docs: [hooks](https://cursor.com/docs/hooks). Not tested |
| Timeout | Per hook, in seconds. The default is "platform default". Staff say it's a minute. A timeout fails open | Docs: [hooks](https://cursor.com/docs/hooks), [forum](https://forum.cursor.com/t/174713) |
| `sessionStart` output | `additional_context` reaches the agent. `env` is passed to later hooks in the same run, but not after `--resume`, which is a new process | Tested |
| `sessionStart` on `--resume` | Doesn't run again. The context from the first turn stays in the chat | Tested |
| Environment of a hook | `CURSOR_PROJECT_DIR`, `CLAUDE_PROJECT_DIR` (the same path), `CURSOR_VERSION`, `CURSOR_USER_EMAIL`, `CURSOR_TRANSCRIPT_PATH`, `CURSOR_INVOKED_AS`, `CURSOR_RIPGREP_PATH`. See [`hook-env.json`](../test/fixtures/cursor/hook-env.json). Plugin hooks also get `CURSOR_PLUGIN_ROOT` | Tested. Docs for `CURSOR_PLUGIN_ROOT`: [hooks](https://cursor.com/docs/hooks) |
| Working directory | Project hooks run from the project root. Plugin hooks run from the plugin's folder, and user hooks from `~/.cursor/` | Tested (project). Docs: [hooks](https://cursor.com/docs/hooks) (the other two) |
| Shell on macOS | `zsh`. `PATH` is rebuilt as in a login shell, so the system folders come first | Tested |
| Workspace trust | Project hooks need a trusted workspace. Headless runs need `--trust` | Docs: [hooks](https://cursor.com/docs/hooks), [CLI changelog](https://cursor.com/docs/cli/changelog). We always passed `--trust` |
| `--force` | Hooks still apply: every deny above was with `--force` | Tested |

### Claude-format hooks ("third-party hooks")

| Question | Answer | Source |
|---|---|---|
| Files read | `.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/settings.json` | Tested (`.claude/settings.json`). Docs: [third-party hooks](https://cursor.com/docs/reference/third-party-hooks) |
| Claude Code plugins | Imported from `~/.claude/plugins`. The installed Comprende 0.2.0 plugin ran its SessionStart in Cursor, and the agent got its message | Tested |
| The on/off setting | "Include Third-Party Plugins, Skills, and Other Configs" (Settings → Agents → Third-Party Imports). It's on by default, and off by default for Enterprise accounts that haven't set it. Staff say the CLI ignores it | Docs: [third-party hooks](https://cursor.com/docs/reference/third-party-hooks), [3.0 changelog](https://cursor.com/changelog/3-0), [forum](https://forum.cursor.com/t/168407) |
| Event mapping | `SessionStart` → `sessionStart`, `PreToolUse` → `preToolUse`. `Notification` and `PermissionRequest` aren't supported | Tested (the first two). Docs for the rest |
| Tool mapping | `"matcher": "Bash"` matches Cursor's `Shell`. A hook with no matcher also gets the other tools, such as Read | Tested |
| Input shape | Cursor's: the same stdin as a `.cursor/hooks.json` hook, so `tool_name: "Shell"`, `hook_event_name: "preToolUse"` and `cwd: ""` | Tested |
| Exit 0, empty stdout | Allowed. Comprende's allow path depends on this | Tested |
| Exit 0, plain text on stdout | Blocked as invalid JSON, unlike Claude Code | Tested |
| Exit 2 + stderr | Blocked. The agent sees `Hook blocked with message: <stderr>` | Tested |
| SessionStart `hookSpecificOutput.additionalContext` | Reaches the agent | Tested |
| `$CLAUDE_PROJECT_DIR` and `${CLAUDE_PROJECT_DIR}` in a command | Both expand to the project root | Tested |
| `${CLAUDE_PLUGIN_ROOT}` in a plugin's hook command | Expands to the plugin's folder | Tested |
| The same hook in both formats | Runs twice | Docs: [forum](https://forum.cursor.com/t/174713) |

### Plugins

| Question | Answer | Source |
|---|---|---|
| `.cursor-plugin/plugin.json` | Only `name` (kebab-case) is required. Optional: `description`, `version`, `author`, `homepage`, `repository`, `license`, `keywords`, `logo`, and paths for `rules`, `agents`, `skills`, `commands`, `hooks`, `mcpServers` | Docs: [plugins reference](https://cursor.com/docs/reference/plugins) |
| Component paths | `skills/<name>/SKILL.md`, `rules/`, `agents/`, `commands/`, `hooks/hooks.json`, and `mcp.json` at the root. A path in the manifest replaces discovery for that component | Docs: [plugins reference](https://cursor.com/docs/reference/plugins) |
| Hooks inside a plugin | Cursor's format. Our `hooks/hooks.json` is Claude's, so a Cursor manifest has to point `hooks` at a separate file | Docs: [plugins reference](https://cursor.com/docs/reference/plugins) |
| Plugin root in hook commands | `${CLAUDE_PLUGIN_ROOT}` expands, as tested with a Claude-format plugin. `CURSOR_PLUGIN_ROOT` is set in the environment. MCP config expands both `${CURSOR_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` | Tested (the first). Docs: [hooks](https://cursor.com/docs/hooks), [plugins reference](https://cursor.com/docs/reference/plugins) |
| `--plugin-dir` with a Claude Code plugin | Works. `--plugin-dir` on this repo loaded Comprende 0.2.1, and its SessionStart and PreToolUse hooks ran | Tested |
| Installing | IDE: Customize → Install. CLI: `agent plugin marketplace add <git-url>`, which needs `.cursor-plugin/marketplace.json` | Docs: [plugins](https://cursor.com/docs/plugins), [CLI changelog](https://cursor.com/docs/cli/changelog). Not tested |
| Team marketplaces | Dashboard → Plugins & MCPs → Add Marketplace, from a Git repo. Teams plans get one, Enterprise unlimited. Install modes: Default Off, Default On, Required | Docs: [plugins](https://cursor.com/docs/plugins) |
| `.claude-plugin/` next to `.cursor-plugin/` | Unknown: the docs are silent and nothing forbids it. Cursor does read Claude plugins, so one repo can likely serve both. To test in the Cursor adapter PR | Unknown |
| Publishing | Submit at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish). Plugins must be open source, and every update is reviewed. The review time isn't stated | Docs: [plugins](https://cursor.com/docs/plugins) |

### Skills, MCP and the CLI

| Question | Answer | Source |
|---|---|---|
| Skill folders | Project: `.cursor/skills`, `.claude/skills` and `.agents/skills`. Home: `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills`. Also the skills of installed Claude Code plugins. `~/.cursor/skills` is in the docs but wasn't seen in our run | Tested. Docs: [skills](https://cursor.com/docs/skills) (`~/.cursor/skills`) |
| Loading by description | Yes. A question matching a skill's description made the agent read that skill's `SKILL.md` and answer from it, for all three project folders | Tested |
| Always-on instructions | A rule with `alwaysApply: true` (`.mdc`) | Docs: [rules](https://cursor.com/docs/rules) |
| MCP config | `.cursor/mcp.json` and `~/.cursor/mcp.json`, with `{"mcpServers": {…}}`. A plugin's MCP file is `mcp.json`. Whether Cursor reads a plugin's `.mcp.json` is unknown, and matters for sharing ours as is | Docs: [MCP](https://cursor.com/docs/mcp). Unknown (`.mcp.json`) |
| Hooks in the CLI | `sessionStart`, `preToolUse` and `beforeShellExecution` all ran in `-p` mode | Tested |
| Headless flags | `-p`, `--output-format stream-json`, `--trust`, `--force`, `--resume <chat>`, `--workspace`, `--plugin-dir`. `CURSOR_API_KEY` works as a login | Tested (all but `CURSOR_API_KEY`). Docs: [parameters](https://cursor.com/docs/cli/reference/parameters) |
| Shell commands in `-p` without `--force` | Unknown: we always passed `--force`. It matters only for the end-to-end script | Unknown |
| Commit attribution | The CLI adds a "Made with Cursor" trailer by default (`attribution.attributeCommitsToAgent`). Contributors using it must turn it off, because of our no-attribution rule | Docs: [CLI configuration](https://cursor.com/docs/cli/reference/configuration) |
| What only the IDE can show | Whether the Agents window gets `sessionStart` context before the first turn: staff say it arrives late. Also what the IDE shows the person on a deny | Unknown (IDE only). Docs: [forum](https://forum.cursor.com/t/174143) |

### Windows

The docs say: "the desktop app runs hook commands through PowerShell and pipes the JSON into the command" ([hooks](https://cursor.com/docs/hooks)). The 2026.11.10 CLI's own code builds hook commands as PowerShell too. Staff say the CLI uses Git Bash when it sees Git Bash's environment (`MSYSTEM`) ([forum](https://forum.cursor.com/t/168129)).

**Unknown by test: we have no Windows machine with Cursor.** It matters a lot, since many Cursor users are on Windows:

- **Our hook commands won't run in PowerShell.** They're POSIX `sh`: `command -v node … || exit 0; exec node "$CLAUDE_PROJECT_DIR/…"`. In PowerShell they fail with a non-2 exit code. They fail open, so nothing breaks, but nothing is checked either.
- **The git pre-push hook still works.** git runs hooks through its own `sh`.
- **The design below fixes this.** It uses plain `node <path> <command>` lines, which run in both shells.

[#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10) tracks Windows.

## Comprende in Cursor today (0.2.2)

| | Claude Code | Cursor |
|---|---|---|
| The skill | yes | yes: imported from the Claude Code plugin |
| The session-start message | yes | yes |
| The pre-push hook installed at session start | yes | yes |
| The agent's `git push` blocked by the Claude hook | yes | yes, since 0.2.2 |
| `git push --no-verify` blocked | yes | yes, since 0.2.2 |
| Without the Claude Code plugin installed | yes, with the repo's `.claude/settings.json` hook | the same, if Third-Party Imports is on |
| On Windows | Git Bash | probably not (PowerShell, above) |

## What's weaker in Cursor than in Claude Code

- **It depends on a setting we don't control.** The Claude hook runs only while Third-Party Imports is on. A person or an admin can turn it off, and Enterprise accounts start with it off. Then nothing blocks the agent's push, except the git hook and CI.
- **Windows probably gets no agent-side check** (above).
- **Stdout is stricter.** One stray line on stdout blocks every shell command. In Claude Code it's harmless. Our hook prints nothing when it allows, and a test checks that.
- **Session context is less reliable.** It arrives late in the IDE's Agents window, according to staff. A resumed chat doesn't run `sessionStart` again: the context from the first turn stays, but `env` set at session start is lost.
- **Hooks can run twice.** Cursor runs the same hook from Claude's settings and from its own files. So two copies of Comprende, one imported from Claude Code and one installed in Cursor, would both run.
- **On a deny, the agent gets `user_message` and never `agent_message`.** There's no separate note for the agent only.
- **MCP servers need approval.** In headless runs, that's `--approve-mcps`. Until then, the memory tools aren't there.

None of this weakens the lock: CI and the ruleset are the same for every tool.

## Codex, from its docs

Checked only to make sure the design fits a third tool. Not tested.

| Question | Answer | Source |
|---|---|---|
| Hooks | `hooks.json` or `[hooks]` in `config.toml`, at `~/.codex/` or `<repo>/.codex/`. Events include `SessionStart` and `PreToolUse`. Each hook has to be trusted once, and again after a bundled script changes | [hooks](https://learn.chatgpt.com/docs/hooks) |
| Shell payload | `tool_name: "Bash"`, `tool_input.command`, `cwd`, `session_id`, `hook_event_name` | [hooks](https://learn.chatgpt.com/docs/hooks) |
| Allow and deny | Exit 0 with no output allows. Exit 2 with the reason on stderr denies, or `hookSpecificOutput.permissionDecision: "deny"`. Other failures let the tool run | [hooks](https://learn.chatgpt.com/docs/hooks) |
| Session context | Plain stdout, or `hookSpecificOutput.additionalContext` | [hooks](https://learn.chatgpt.com/docs/hooks) |
| Plugins | A root `plugin.json`, or `.codex-plugin/plugin.json`, with hooks in `hooks/hooks.json`. `PLUGIN_ROOT` is set, and `CLAUDE_PLUGIN_ROOT` too. Plugins with lifecycle hooks aren't eligible for the public directory | [plugins](https://developers.openai.com/plugins/build/plugins) |
| Skills | `.agents/skills`, from the working folder up to the repo root, and `~/.agents/skills`. They're picked by description | [skills](https://learn.chatgpt.com/docs/build-skills) |
| Windows | An optional `commandWindows` per hook. Which shell runs a hook isn't documented | [hooks](https://learn.chatgpt.com/docs/hooks) |

## Design proposal

### What the three tools share

- **Allowing:** exit 0 with empty stdout allows in all three tools.
- **Denying:** exit 2 with the reason on stderr denies in all three, and the reason reaches the agent.
- **Session context:** `hookSpecificOutput.additionalContext` reaches the agent in all three.
- **Where they differ is the input:**
  - the shell tool's name: `Bash` or `Shell`
  - where the repo comes from: `cwd`, or `CLAUDE_PROJECT_DIR` when `cwd` is `""`
  - the event's name
  - the plugin-root variable
  - the file that registers a hook in the repo

The adapter is small for that reason: it validates what comes in, and the core decides.

### The agent-adapter interface

`src/gate/agents/agent.ts`, with one adapter per tool: `claude-code.ts`, `cursor.ts` and later `codex.ts`. It replaces `SHELL_TOOL_NAMES` in `shared.ts` and the `.claude/settings.json` reading in `hooks.ts` ([#18](https://github.com/AbdulrahmanMasoud/comprende/issues/18)).

```ts
/** One AI coding tool's hook protocol. The core decides; the adapter translates. */
export interface Agent {
  /** "claude-code" | "cursor" | "codex": for `--agent`, logs and messages. */
  readonly id: AgentId;

  /** Is this hook run from this tool? Cursor runs Claude Code's hook commands too,
   *  so the same command has to tell them apart (Cursor sets CURSOR_VERSION). */
  detects(payload: unknown, env: HookEnv): boolean;

  /** The shell command about to run and the repo it runs in, validated at the edge,
   *  or null for any other tool. Knows the shell tool's name ("Bash", "Shell"). */
  shellCommand(payload: unknown, env: HookEnv): { command: string; projectDir: string } | null;

  /** The repo a session starts in. Cursor sends no cwd at session start, so this
   *  falls back to the tool's project variable. */
  sessionProjectDir(payload: unknown, env: HookEnv): string;

  /** Let the command run. It must print nothing this tool would misread:
   *  Cursor blocks a command when stdout isn't JSON. */
  allow(): HookReply;

  /** Block the command. The reason has to reach the agent: stderr on exit 2 in all three tools. */
  deny(reason: string): HookReply;

  /** The session-start reply that adds context for the agent. */
  sessionContext(text: string): HookReply;

  /** The plugin's install folder, from this tool's variable
   *  (CLAUDE_PLUGIN_ROOT, CURSOR_PLUGIN_ROOT, PLUGIN_ROOT). */
  pluginRoot(env: HookEnv): string | null;

  /** The repo's own hook file for this tool (.claude/settings.json, .cursor/hooks.json):
   *  whether it already runs the gate, so the plugin's hook steps aside, and how
   *  `install` adds the gate's hook to it. */
  readonly projectHooks: {
    path: string;
    runsGate(root: string): boolean;
    addGateHook(root: string): string;
  };
}

/** What a hook prints and how it exits. Only 0 and 2: a hook blocks only on a deliberate 2. */
export interface HookReply {
  stdout: string;
  stderr: string;
  exitCode: 0 | 2;
}
```

How each tool fills it in:

| | Claude Code | Cursor | Codex (docs) |
|---|---|---|---|
| Shell tool | `Bash` | `Shell` | `Bash` |
| Project folder | `cwd`, else `CLAUDE_PROJECT_DIR` | `CURSOR_PROJECT_DIR` (`cwd` is `""`) | `cwd` |
| Session context | `hookSpecificOutput.additionalContext` | the same, or `additional_context` | the same |
| Plugin root | `CLAUDE_PLUGIN_ROOT` | `CURSOR_PLUGIN_ROOT` | `PLUGIN_ROOT` |
| Repo hook file | `.claude/settings.json` | `.cursor/hooks.json` | `.codex/hooks.json` |

The platform adapter (GitHub, then GitLab in [#4](https://github.com/AbdulrahmanMasoud/comprende/issues/4)) is the other half of #18. It covers the CI workflow, CODEOWNERS, the PR's branch and labels, the reviewer summary, and `protect`.

### Files to add for Cursor

- **`.cursor-plugin/plugin.json`:**
  - `name: "comprende"`, the version, description, author, repository, license and logo
  - `"hooks": "./hooks/cursor-hooks.json"`, because `hooks/hooks.json` is Claude-format
  - `"mcpServers": "./.mcp.json"`
  - `tools/release.mjs` checks its version together with the other version files
- **`.cursor-plugin/marketplace.json`:** for `agent plugin marketplace add https://github.com/AbdulrahmanMasoud/comprende`.
- **`hooks/cursor-hooks.json`:** in Cursor's format:
  - `sessionStart`: `node "${CURSOR_PLUGIN_ROOT}/dist/gate.mjs" session-start --agent cursor`
  - `preToolUse`, with `"matcher": "Shell"`: `node "${CURSOR_PLUGIN_ROOT}/dist/gate.mjs" claude-hook --from-plugin --agent cursor`

  These are plain `node` lines, with no POSIX guards, so they run in PowerShell too. Without `node`, the shell exits with a non-2 code, and the hook fails open.
- **Shared as is:**
  - `skills/`: Cursor reads `SKILL.md` and loads it by description.
  - The MCP server, `dist/server.mjs` through `.mcp.json`: Cursor expands `${CLAUDE_PLUGIN_ROOT}` in MCP config. That `.mcp.json` is read is to be confirmed in that PR.
- **No rule file:** the always-on line keeps coming from `sessionStart`, as in Claude Code. See open question 4.

### What `gate.mjs install` writes for teammates on Cursor

**Recommendation:** also write `.cursor/hooks.json` with the same `preToolUse` hook, `node .learning/gate.mjs claude-hook --agent cursor`, and don't rely only on the `.claude/settings.json` import.

- **It still works when Third-Party Imports is off.**
- **It works on Windows:** a relative `node` command runs in PowerShell and in `sh`, and project hooks run from the repo root.
- **It runs only once.** When the Claude-format hook runs inside Cursor and `.cursor/hooks.json` already runs the gate, it steps aside. This is the same rule as the plugin stepping aside for the repo's hook.
- **It's protected like the other gate files:** `.cursor/hooks.json` joins `GATE_FILES` and CODEOWNERS.

### Install steps for a Cursor user (after 0.3.0)

1. Install Node.js 20 or newer.
2. Install the plugin: `/plugin` in the Cursor CLI, or Customize → Install in the IDE, from the marketplace. Without the marketplace: `agent plugin marketplace add https://github.com/AbdulrahmanMasoud/comprende`. If Comprende is already in Claude Code, Cursor imports it, so skip this step.
3. Open a repo that uses the gate and trust the workspace. The repo's `.cursor/hooks.json` does the rest.

### Test plan

- **Unit tests from the captured payloads,** in [`test/fixtures/cursor/`](../test/fixtures/cursor/):
  - each adapter reads each fixture into the right typed event, or into `null`
  - `allow`, `deny` and `sessionContext` produce exactly what the tool expects: empty stdout on allow, exit 2 with stderr on deny
  - `install` writes `.cursor/hooks.json`, keeps a file that's already there, and refuses symlinks
  - the step-aside rules: the plugin's hook steps aside for the repo's hook, and the Claude-format hook steps aside for `.cursor/hooks.json` when it runs in Cursor
- **Real Claude Code payloads,** captured into `test/fixtures/claude-code/` in the refactor PR.
- **An end-to-end script you can rerun,** `tools/cursor-e2e.mjs`, added in the Cursor adapter PR. It needs a logged-in `cursor-agent` and isn't part of CI. It does what we did by hand for 0.2.2:
  1. Build a gated demo repo in a temp folder, with a local bare remote and an unverified commit, and remove the git pre-push hook.
  2. Run `cursor-agent -p --output-format stream-json --trust --force` there, with `HOME` set to a temp folder. On macOS, that folder links to `~/Library/Keychains`, so the login still works and no personal config loads.
  3. Ask it to run `ls`, `git status` and `git push`. Expect the first two to run, and the push to be rejected with the gate's message.
  4. Save a report, commit it, and push again. Expect the push to go through.
  5. Start a new session and check that the agent can quote the session-start message.

### The order of PRs

1. **`refactor:` agent and platform adapters ([#18](https://github.com/AbdulrahmanMasoud/comprende/issues/18)).** Extract the Claude Code and GitHub adapters, with no change in behavior. It also captures Claude Code fixtures and splits `setup.ts`.
2. **`feat:` the Cursor adapter (part of [#2](https://github.com/AbdulrahmanMasoud/comprende/issues/2)).** `cursor.ts`, `.cursor-plugin/`, `hooks/cursor-hooks.json`, `.cursor/hooks.json` from `install`, the step-aside rule, the tests and the end-to-end script.
3. **`docs:` and the 0.3.0 release.** Both READMEs, `docs/teams.md`, this page, `SECURITY.md` (the new hook file) and the CHANGELOG.

## Open questions

1. **`.cursor/hooks.json`:** should `install` write it, as recommended above, or should we rely on Cursor importing `.claude/settings.json`?
2. **Distribution:** submit to the Cursor Marketplace (open source, reviewed, unknown wait), or ship only as a GitHub marketplace (`agent plugin marketplace add`) at first?
3. **Two copies:** someone with Comprende in both Claude Code and Cursor gets the skill and the hooks twice in Cursor: once imported, once native. Do we document "install it in one place", or make the native Cursor plugin step aside when the imported one is present?
4. **Always-on line:** keep it in `sessionStart`, as tested here, or also ship an `alwaysApply` rule? The rule survives the Agents window's late context, but it's a second copy of the text.
5. **Windows:** we can't test Cursor on Windows. Is shipping Cursor support with Windows marked experimental (#10) acceptable?
6. **Codex:** add it to the v0.3.0 milestone, or later? Its per-hook trust step makes the first run less smooth.

## How we tested

- **The probe repo.** A throwaway repo with a local bare remote, so pushes went nowhere. It had:
  - hooks in both formats (`.cursor/hooks.json` and `.claude/settings.json`) that only recorded their stdin and environment, then answered in each event's format
  - one command each format denied on purpose (a Cursor-format deny with `agent_message`, and a Claude-format exit 2 with stderr)
  - the Claude-format allow path kept silent, like Comprende's
  - a skill in each of `.cursor/skills`, `.claude/skills` and `.agents/skills`
- **Comprende itself.** The gated demo from CLAUDE.md, "The ownership gate", with Comprende 0.2.1 and then 0.2.2. A `NODE_OPTIONS=--import` preload logged every `gate.mjs` run, so the repo's files stayed untouched.
- **How it was run.** `cursor-agent` in headless mode, with a clean environment and a throwaway `HOME`, so no personal config or plugins loaded. One run used the real `HOME`, to see Cursor import the installed Claude Code plugins.
- **The captures.** They're in [`test/fixtures/cursor/`](../test/fixtures/cursor/), with personal data removed.
