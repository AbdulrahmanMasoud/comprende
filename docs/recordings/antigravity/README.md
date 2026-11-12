# Antigravity recordings

Real runs of the Antigravity CLI (`agy`) with Comprende installed. [`docs/agents.md`](../../agents.md#antigravity-what-we-found) quotes them.

They live in `docs/`, not `test/fixtures/`: no test reads them. The hook payloads that tests read go in `test/fixtures/antigravity/`, with the change whose tests use them.

## Step 0: does today's Comprende block commands in Antigravity? (0.4.2)

Comprende 0.4.2, installed with `agy plugin install`, which converts it from the Claude Code plugin. Its hook replies with nothing, and Antigravity's docs don't say what an empty reply does. Antigravity's docs also say a non-zero exit "fails open".

### How it was recorded

- **When and where:** 2026-11-12, on macOS, with the Antigravity CLI `agy` `1.5.5`, signed in with a Google account. The model, from the payloads, was `gemini-3.8-flash-high`.
- **Isolation:** a throwaway `HOME` with its own macOS keychain for the sign-in token. Both were deleted after the run.
- **The plugin:** this repo at 9e92be0 (0.4.2, plus a refactor with no behavior change), installed with `agy plugin install` from a local copy: "1 skill, 1 MCP server, 2 hooks".
- **The demos:**
  - `/work/app`: a gated repo (`mode: required`) with a local bare remote, an unverified `sum(xs)` on `feature/sum`, and git's `pre-push` hook.
  - `/work/plain`: a repo without the gate.
- **Headless:** each step is one `agy -p "<prompt>" --output-format stream-json`. Headless mode can't ask for a permission, so it denies any command without an allow rule. Steps that needed a command to run pass one with `--settings`, for that run only.
- **The gate's runs:** logged by a `NODE_OPTIONS` preload, the way `tools/e2e-codex.mjs` does it. Each entry has the command line, the folder the gate ran in, the payload on stdin, the reply, the exit code, and the names of the environment variables (not their values).
- **What was changed:** the paths, to `/work/app`, `/work/plain` and `/work/home`. Nothing else, and nothing personal is in the files.

### The runs

| Step | Folder | Setup | Result | Comprende's hook |
|---|---|---|---|---|
| `1-gated-ls` | gated | Comprende on, no allow rule | `ls` denied: "permission check failed for unsandboxed "ls"" | ran: exit 0, nothing on stdout |
| `2-gated-ls-allowed` | gated | Comprende on, `ls` allowed | `ls` ran: `math.js` | ran: exit 0, nothing on stdout |
| `3-control-no-plugin-ls` | gated | Comprende disabled, no allow rule | `ls` denied, the same message as step 1 | didn't run |
| `4-plain-ls` | without the gate | Comprende on, `ls` allowed | `ls` ran: `notes.txt` | ran: exit 0, nothing on stdout |
| `5-gated-push` | gated | Comprende on, the push allowed | the push failed: git's `pre-push` hook blocked it, and the branch never reached the remote | ran: exit 0, nothing on stdout |
| `6-exit2-ls` | gated | `ls` allowed, plus a user hook that exits 2 | `ls` blocked: "JSON hook … failed: command failed: exit status 2" | its session start ran |
| `7-exit1-ls` | gated | `ls` allowed, plus a user hook that exits 1 | `ls` blocked: "… exit status 1" | its session start ran |

The test hooks in steps 6 and 7 were in `~/.gemini/config/hooks.json`, and were removed after each step. They ran before Comprende's hook, and their failure ended the tool call.

### What they show

- **An empty reply doesn't block.** The command goes on to Antigravity's own permission check (steps 1 to 4). Step 3 shows that check denies `ls` without Comprende too.
- **Any non-zero exit blocks the command,** 1 as well as 2 (steps 6 and 7). This contradicts the docs.
- **The payloads have `cwd`.** `PreToolUse` also has `hookEventName`, `stepIdx` and `toolCall: {id, name, args}`, and for `run_command`, `args` has `CommandLine`, `WaitMsBeforeAsync` and `toolSummary`. The full payloads are in `runs.json`.
- **Plugin hooks run in the plugin's folder,** with `PLUGIN_ROOT`, `PLUGIN_DATA` and `ANTIGRAVITY_CONVERSATION_ID` in their environment.
- **The session start finds the repo, and Antigravity rejects its reply.** The gate printed the always-on line and the gate's message, in Claude Code's shape. Antigravity logged `unknown field "hookSpecificOutput"`, in its own log only (`agy-log-hook-lines.txt`). The agent got nothing, and nothing showed on the terminal.
- **A push in the gated repo** is let through by the plugin's hook, which can't read this payload, and blocked by git's `pre-push` hook. The agent quoted the gate's message (step 5).
- **The memory server started:** Antigravity listed its 10 tools. No step called one.

### The files

- `runs.json`: each step's prompt, `agy` flags, tool calls, the agent's reply, what `agy` printed on stderr, and each gate run with its payload and reply.
- `agy-log-hook-lines.txt`: Antigravity's own log lines about hooks and settings, for each step.
