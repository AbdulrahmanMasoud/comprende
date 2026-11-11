# Codex hook payloads

Real hook input from Codex, captured on 2026-11-11 with the Codex CLI `0.167.1` on macOS, in headless mode (`codex exec --json`), signed in with ChatGPT. Each file is the JSON a hook read on stdin, except `hook-env.json`. No test reads them yet: they're for the Codex adapter ([#3](https://github.com/AbdulrahmanMasoud/comprende/issues/3)).

Don't write these by hand. To change one, capture it again from a real run.

| File | The hook and the case |
|---|---|
| `session-start.json` | `SessionStart`, at the start of a new session (`source: "startup"`) |
| `pre-tool-use.bash.git-push.json` | `PreToolUse` before the shell tool runs `git push origin main` |
| `pre-tool-use.bash.git-status.json` | `PreToolUse` before `git status` |
| `pre-tool-use.bash.echo.json` | `PreToolUse` before `echo probe-silent`, a command the probe hook allowed silently |
| `hook-env.json` | The `CODEX_*` and `*PLUGIN*` environment variables a plugin hook got (Comprende 0.3.0's `session-start`) |

Things to know:

- The payloads are Claude Code's shape, plus `turn_id` and `model`, which Claude Code doesn't send. The shell tool is `Bash`, and the command is `tool_input.command`.
- `cwd` is the command's folder. Hooks ran in the session's folder, here the repo's root.
- The same payload went to the user's `hooks.json`, the project's `.codex/hooks.json` and the plugin's hooks.
- `permission_mode` is `bypassPermissions` here because of headless mode.

## How the captures were cleaned

The values below were replaced. Nothing else was changed, apart from formatting.

- **The project path:** `/work/probe-app`.
- **The home folder:** `/home/user`, and `CODEX_HOME` became `/home/user/.codex`. The npm package's folder became `/usr/local/lib/node_modules/@openai/codex`.
- **IDs:** the session, turn and tool-call ids became `00000000-0000-4000-8000-00000000000N`, numbered in the order they first appeared, across all the files. `tool_use_id` keeps its `exec-` prefix.
