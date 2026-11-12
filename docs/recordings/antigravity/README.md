# Antigravity recordings

Real runs of the Antigravity CLI (`agy`) with Comprende installed. [`docs/agents.md`](../../agents.md#antigravity-what-we-found) quotes them.

They live in `docs/`, not `test/fixtures/`: no test reads them. The hook payloads that tests read go in `test/fixtures/antigravity/`, with the change whose tests use them.

## Step 0: does Comprende 0.4.2 block commands in Antigravity?

No. Its shell hook replies with nothing, and Antigravity doesn't block on that. But any non-zero exit from a hook blocks the command, and the gate's hooks exit 1 when they fail.

Step 0 was the first signed-in run: Comprende 0.4.2, installed with `agy plugin install`, which converts it from the Claude Code plugin, before any Antigravity support. Antigravity's docs don't say what an empty reply does, and say a non-zero exit is "ignored (failing open)".

### How it was recorded

- **When and where:** 2026-11-12, on macOS, with the Antigravity CLI `agy` `1.5.5`, signed in with a Google account. The model, from the payloads, was `gemini-3.8-flash-high`.
- **Isolation:** a throwaway `HOME` with its own macOS keychain for the sign-in token. Both were deleted after the run.
- **The plugin:** this repo at 9e92be0 (0.4.2, plus a refactor with no behavior change), installed with `agy plugin install` from a local copy: "1 skill, 1 MCP server, 2 hooks".
- **The demos:**
  - `/work/app`: a gated repo (`mode: required`) with a local bare remote and an unverified `sum(xs)` on `feature/sum`. Its git `pre-push` hook was installed by `gate.mjs install` during the setup, not by Antigravity's session start.
  - `/work/plain`: a repo without the gate.
- **Headless:** each step is one `agy -p "<prompt>" --output-format stream-json`. Headless mode can't ask for a permission, so it denies any command without an allow rule. Steps that needed a command to run pass one with `--settings`, for that run only.
- **The gate's runs:** logged by a `NODE_OPTIONS` preload, the way `tools/e2e-codex.mjs` does it. Each entry has the command line, the folder the gate ran in, the payload on stdin, the reply, the exit code, the names of the environment variables, and the value of `PLUGIN_ROOT`. Git's `pre-push` hook in step 5 isn't in the log: the pinned hook runs the repo's `gate.mjs` in memory, which the preload doesn't see.
- **What was changed:**
  - the paths, to `/work/app` and `/work/plain`, and the home folder to `/home/user`
  - the conversation and tool-call IDs, to `00000000-0000-4000-8000-00000000000N`, numbered in the order they first appear. `toolCall.id` keeps its `call_` prefix
  - `agy-log-hook-lines.txt` keeps only the lines about hooks and settings, each cut at 700 characters

  Nothing else, and nothing personal is in the files.

### The runs

| Step | Folder | Setup | Result | Comprende's hook |
|---|---|---|---|---|
| `1-gated-ls` | gated | Comprende on, no allow rule | `ls` denied: `permission check failed for unsandboxed "ls"` | ran: exit 0, nothing on stdout |
| `2-gated-ls-allowed` | gated | Comprende on, `ls` allowed | `ls` ran: `math.js` | ran: exit 0, nothing on stdout |
| `3-control-no-plugin-ls` | gated | Comprende disabled with `agy plugin disable comprende`, no allow rule | `ls` denied, the same message as step 1 | didn't run |
| `4-plain-ls` | without the gate | Comprende on, `ls` allowed | `ls` ran: `notes.txt` | ran: exit 0, nothing on stdout |
| `5-gated-push` | gated | Comprende on, the push allowed | the push failed: git's `pre-push` hook blocked it. Afterwards, `git ls-remote --heads origin` listed only `main` | ran: exit 0, nothing on stdout |
| `6-exit2-ls` | gated | `ls` allowed, plus a user hook that exits 2 | `ls` blocked: `JSON hook … failed: command failed: exit status 2` | didn't run (only its session start did) |
| `7-exit1-ls` | gated | `ls` allowed, plus a user hook that exits 1 | `ls` blocked: `… exit status 1` | didn't run (only its session start did) |

The test hooks in steps 6 and 7 were in `~/.gemini/config/hooks.json`, and were removed after each step. They ran before Comprende's hook, and their failure ended the tool call.

### What they show

- **An empty reply doesn't block.** The command goes on to Antigravity's own permission check (steps 1, 2 and 4). Step 3 is the control: that check denies `ls` without Comprende too.
- **Any non-zero exit blocks the command,** 1 as well as 2 (steps 6 and 7). This contradicts the docs. The test hooks were user hooks; the plugin's hooks go through the same runner (Antigravity names both `jsonhook__<group>_<event>_…`), so they're taken to behave the same.
- **The payloads have `cwd`.** Both events' payloads have `cwd` and `hookEventName`. `PreToolUse` adds `stepIdx` and `toolCall: {id, name, args}`, and for `run_command`, `args` has `CommandLine`, `WaitMsBeforeAsync` and `toolSummary`. The full payloads are in `runs.json`.
- **Plugin hooks run in the plugin's folder,** with `PLUGIN_ROOT`, `PLUGIN_DATA` and `ANTIGRAVITY_CONVERSATION_ID` in their environment.
- **The session start finds the repo, and Antigravity rejects its reply.** The gate printed the always-on line and the ownership-gate note, in Claude Code's shape. Antigravity logged that the hook failed, in its own log only (`agy-log-hook-lines.txt`). The agent got nothing, and nothing showed on the terminal. The error's end, `unknown field "hookSpecificOutput"`, shows in step 4's line, the only one short enough to keep it.
- **A push in the gated repo** is let through by the plugin's hook, which can't read this payload, and blocked by git's `pre-push` hook. The agent quoted the gate's message (step 5).
- **The memory server started.** Antigravity cached one schema file per tool in `~/.gemini/antigravity-cli/mcp/comprende_comprende/`: the 10 tools, `add_decision` to `update_map`. That folder isn't in the recording, and no step called a tool.

### What it didn't test

The IDE and the App, the interactive CLI, Linux and Windows, a gate crash or a Node.js that can't load `gate.mjs` (inferred from steps 6 and 7), and everything in [`docs/agents.md`](../../agents.md#how-we-tested)'s "Still to run signed in".

### The files

- `runs.json`: each step's prompt, `agy` flags, tool calls, the agent's reply, what `agy` printed on stderr, and each gate run with its payload and reply.
- `agy-log-hook-lines.txt`: Antigravity's own log lines about hooks and settings, for each step.

## The 0.4.3 fix: a failed hook lets the command run

0.4.3 gives Antigravity its own plugin files: `.antigravity-plugin/plugin.json`, a root `hooks.json` and a root `mcp_config.json`. With its own manifest, `agy plugin install` uses them as they are, instead of converting the Claude Code plugin. Each hook command is:

```sh
set "A=$(node "$PLUGIN_ROOT/dist/gate.mjs" … --from-plugin; printf 'x%s' "$?")$(exit 0)"; held=${1#A=}; code=${held##*x}; ok=${code%%[1-9]*}; reply=${held%x*}; printf '%s' "${ok:+$reply}"; exit 0
```

The shell keeps the gate's output, prints it only when the gate exits 0, and otherwise exits 0 with nothing on stdout. It has no `&&` or `||`, so that `cmd.exe` and both PowerShells exit 0 too (tested in the Windows workflow), in case Antigravity uses one of them on Windows ([docs/agents.md](../../agents.md#comprende-043-in-antigravity)).

### How it was recorded

The same way as Step 0, with these changes:

- **The plugin:** the fix's branch at dc8e731, installed with `agy plugin install` into a fresh throwaway `HOME`: "1 skill, 1 MCP server, 1 hook", `Source: antigravity`. For a plugin's own `hooks.json`, the install message counts hook groups ("1 installed (comprende)"); for a converted one, it counts events ("2 installed (PreToolUse, SessionStart)").
- **The gated demo** also has its own `dist/gate.mjs` and `dist/server.mjs`, committed. Each writes a marker file in `/work/markers` if it ever runs. After every step, that folder was empty.
- **The gate's runs** log the script's own path, and the MCP server's start.
- **Steps 3 and 4** changed the installed plugin's `dist/gate.mjs`, and put it back after the step (the same SHA-256).
- **Steps 1 to 6** ran with the final command. Step 6a, and steps 7 to 9, ran with an earlier draft (`out=$(…) && printf … || exit 0`): 6a only to learn the MCP permission's name, and 7 to 9 test Antigravity, not Comprende, with a user hook in `~/.gemini/config/hooks.json` that ran first and was removed after the step.
- **The files:** `0.4.3/runs.json`, with the same replacements as Step 0 (paths, home folder, IDs). Its first entry names the commit and the hook command.

### The runs

| Step | Setup | Result | Comprende's hook |
|---|---|---|---|
| `1-normal-ls` | 0.4.3, `ls` allowed | `ls` ran | the plugin's own `dist/gate.mjs` ran in the plugin's folder: the session start (exit 0, its reply) and the shell hook (exit 0, nothing on stdout). The MCP server started from the plugin's `dist/server.mjs` |
| `2-no-node-ls` | `node` not on PATH | `ls` ran | both hooks ran: Antigravity's log has `sh: node: command not found` twice (in `runs.json`, as `agy_log`) |
| `3-no-gate-ls` | the plugin's `dist/gate.mjs` moved aside | `ls` ran | `node` exited 1 for both hooks, `ERR_MODULE_NOT_FOUND`. The repo's own `dist/gate.mjs` didn't run |
| `4-partial-crash-ls` | a stand-in `gate.mjs` that writes partial JSON, then throws | `ls` ran | the stand-in exited 1 for both hooks. The log shows no stdout, because the stand-in writes with `writeSync`, which the preload doesn't see; the tests check that it prints the partial JSON |
| `5-push` | the push allowed | git's `pre-push` hook blocked it; `origin` still had only `main` | the shell hook ran, and allowed: it can't read this payload yet (0.5.0) |
| `6a-mcp-probe` | no allow rule | the MCP call denied: `mcp(comprende_comprende/gate_status)` needs an allow rule in headless mode | |
| `6-mcp-gate-status` | `mcp(comprende_comprende/gate_status)` allowed | the agent called `gate_status` and summed up its answer | the server ran from the plugin's folder |
| `7-user-hook-non-json-ls` | a user hook that prints `not-json` on exit 0 | `ls` blocked: `failed to unmarshal result … invalid value not-json` | |
| `8-user-hook-timeout-ls` | a user hook that outlives its timeout | `ls` blocked: `command failed: signal: killed` | |
| `9-shell-probe` | `SHELL=/bin/zsh`, and a user hook that prints its own shell | `ls` ran. The hook's shell was `sh` | |

### What they show

- **A failed hook no longer blocks.** Without `node`, without `gate.mjs`, or after a crash with partial output, the command ran (steps 2 to 4).
- **Every path is the plugin's own.** The hooks ran the installed plugin's `dist/gate.mjs`, in its folder, and the MCP server its `dist/server.mjs`, through `${PLUGIN_ROOT}`. The repo's own `dist/` files never ran (all steps).
- **The shell has to hold the output back.** Non-JSON stdout on exit 0 blocks the command too (step 7). So `node … || exit 0` alone would have let a crash's partial output through, and blocked.
- **A timeout blocks, and no wrapper can help with it** (step 8): the shell itself is killed. In 0.4.3 the gate allows Antigravity's payload before doing any work.
- **On macOS, Antigravity runs hooks with `sh`,** not the user's `$SHELL` (steps 2 and 9).

## 0.5.0: the adapter

First, what Antigravity does with each reply the adapter could send, with test hooks; then the adapter itself, from the `feat/antigravity-adapter` branch at 63f5e15.

### How it was recorded

The same way as 0.4.3, in the same signed-in throwaway `HOME`. Steps `e1` to `e5` use test hooks in `~/.gemini/config/hooks.json`, a scratch repo with its own `.agents/hooks.json`, or a throwaway probe plugin, each removed after its step. Steps `a1` to `b2` use the branch's plugin: "1 skill, 1 rule, 1 MCP server, 1 hook". The files: `0.5.0/runs.json`, with the same replacements as before, plus the local time Antigravity adds to a prompt.

### The runs

| Step | Setup | Result |
|---|---|---|
| `e1-session-context-shapes` | three SessionStart hooks, one per `injectSteps` shape | the agent named all three code words. The transcript has `userMessage` as a `USER_INPUT` step, `ephemeralMessage` as an `EPHEMERAL_MESSAGE`, and `systemMessage` as a `SYSTEM_MESSAGE` that says "The following system message was injected by a SessionStart hook" |
| `e2a-json-deny-ls` | a PreToolUse hook that prints a JSON deny on exit 0 | `ls` blocked: `tool call denied by pre-tool hook: PROBE-DENY: …` |
| `e2b-json-allow-no-rule-ls` | a PreToolUse hook that prints `{"decision": "allow"}`, no allow rule | `ls` still denied by Antigravity's own permission check |
| `e3-agents-hooks-ls` | a repo with its own `.agents/hooks.json`, and the plugin | both ran on each event. The repo's hooks ran in `<repo>/.agents`, with no trust step |
| `e4-skill-code-change` | "Add a function mul(a, b) … to math.js" | the agent's first step read the plugin's `skills/comprende/SKILL.md` |
| `e5-plugin-rule` | a probe plugin with `rules/AGENTS.md` | the agent quoted the rule's code word |
| `a1-gated-session-context` | the adapter, in the gated repo | the agent quoted the instruction once, "a rule", and one system message: "Comprende is installed, and its hooks run in this session.", then the gate's note. The note also said the repo's `gate.mjs` differs from the plugin's: the demo was set up with 0.4.3's gate. A first try hit `agy`'s 5-minute print timeout, with no reply, and was run again |
| `a2-plain-session-context` | the adapter, in a repo without the gate | the instruction once, from the rule, and "Comprende is installed, and its hooks run in this session." as a system message. Antigravity's log has no hook error |
| `b1-gated-push` | the adapter, an unverified push allowed | blocked by Comprende's own hook: `tool call denied by pre-tool hook: Blocked by the ownership gate: - No ownership report for branch 'feature/sum' … Ask Antigravity to run the ownership check ("check me")`. The push never started: `origin` still had only `main` |
| `b2-gated-ls` | the adapter, `ls` allowed | `ls` ran. The hook replied with nothing |

### What they show

- **The adapter's two replies work as designed.** A JSON deny on exit 0 blocks, with the reason shown, and nothing allows. `{"decision": "allow"}` would mean the same, so the gate never sends it.
- **The system message is the shape for the gate's note:** the agent reads it as instructions, not as the user's request.
- **The always-on instruction comes once,** from the plugin's rule, and the session start only says the hooks ran. The rule leaves out the words "Comprende is installed", which the skill reads as "the hooks ran", since a rule also loads where hooks don't run.
- **A repo's `.agents/hooks.json` would run the gate a second time,** so `install` doesn't write one.

## 0.5.0: the end-to-end script's first run

[`tools/e2e-antigravity.mjs`](../../../tools/e2e-antigravity.mjs), on the `chore/e2e-antigravity` branch, with `main` at ba1b1b7 (the adapter, #63). The files: `0.5.0-e2e/`, the replies the script saved and a `results.json`, with the run folders replaced by `/work` and the throwaway `HOME` by `~`. The replies weren't changed otherwise. `results.json` was put together from two runs, below: run 1's install and `main`, and run 3's `explain`. Run 3's own install line, which also passed, was left out.

### How it was recorded

- **When and where:** 2026-11-12, on macOS, `agy` 1.5.5, headless, in the same signed-in throwaway `HOME` as the runs above.
- **The prompts:** the script's own, shared with the Cursor and Codex scripts (`tools/e2e-common.mjs`). Each turn allowed only what its step needs.
- **Three runs, all 15 steps passed once:**
  - **Run 1:** everything in `main` passed. `explain` failed: the skill read its files, then called the memory server's `learning_context`, which that turn had no allow rule for, so the turn ended with no reply. The script now allows the memory server there.
  - **Run 2, `explain` only:** the run folder sat inside a scratch folder that also held a draft of the script. Looking for existing code, the agent searched the folders around the run, listed their files, and tried to read the draft; that read was denied, and the turn ended with no reply. Only file names were sent. Since then, CONTRIBUTING.md says to give each run a fresh `--out` with nothing beside it.
  - **Run 3, `explain` only, in a new temp folder:** passed.
- **After the runs,** the script's checks were made stricter, after a review: the session start's checks now read what the hook sent from the log, besides the agent's quotes; a failure without an `AGY_ERROR` stops the run instead of reading as BLOCKED; and the plugin's copy is every file git tracks. `RERUN`

### What they show

- **The plugin installs as Antigravity's own:** "1 skill, 1 rule, 1 MCP server, 1 hook".
- **Session start:** the instruction once, "a rule", and one system message with "Comprende is installed, and its hooks run in this session." and the gate's note (`1-session-start.reply.md`).
- **The hooks run the installed plugin's `gate.mjs`,** never the repo's: every hook run in the log was `~/.gemini/config/plugins/comprende/dist/gate.mjs`.
- **An ordinary command runs,** and the hook ran and replied with nothing.
- **An unverified push is denied once,** with the reason (`3-unverified-push.reply.md`): `tool call denied by pre-tool hook: Blocked by the ownership gate: …`.
- **"check me":** one question for the small change (`4-check-me.reply.md`). After the answer, the agent saved the report with the memory server's `save_check_report`, committed it, and the push went through (`4-answers.reply.md`).
- **The memory server:** `learning_context` answered (`5-memory.reply.md`).
- **Explain-as-you-build:** the agent's first step read the plugin's `SKILL.md`, and it explained only the full jitter, briefly (`7-explain-as-you-build.reply.md`). The demo is gated, so it ended with an optional in-flight question, as the skill's ownership check says.
