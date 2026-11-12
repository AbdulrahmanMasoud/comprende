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
