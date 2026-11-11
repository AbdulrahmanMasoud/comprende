# Cursor hook payloads

Real hook input from Cursor, captured on 2026-11-11 with Cursor CLI `2026.11.10-731fb78` on macOS, in headless mode (`cursor-agent -p --trust --force`). Each file is the JSON a hook read on stdin, except `hook-env.json`.

Don't write these by hand. To change one, capture it again from a real run.

| File | The hook and the case |
|---|---|
| `session-start.json` | `sessionStart`, at the start of a new chat |
| `pre-tool-use.shell.git-push.json` | `preToolUse` before the shell tool runs `git push origin feature/probe` |
| `pre-tool-use.shell.git-status.json` | `preToolUse` before `git status` |
| `pre-tool-use.shell.ls.json` | `preToolUse` before `ls` |
| `pre-tool-use.read.json` | `preToolUse` before the Read tool (not a shell command) |
| `before-shell-execution.git-push.json` | `beforeShellExecution` before `git push origin feature/probe` |
| `before-shell-execution.git-status.json` | `beforeShellExecution` before `git status` |
| `hook-env.json` | The `CURSOR_*` and `CLAUDE_*` environment variables a project hook got |

Things to know:

- Cursor gives the same stdin to a Claude-format hook (`.claude/settings.json`) as it does to its own hooks (`.cursor/hooks.json`). The event is named `preToolUse`, not `PreToolUse`, and the shell tool is `Shell`, not `Bash`. The `preToolUse` files were captured through a Claude-format hook with `"matcher": "Bash"`.
- `cwd` is an empty string. The repo comes from `CLAUDE_PROJECT_DIR` or `CURSOR_PROJECT_DIR`. Cursor sets both, and runs project hooks from the project root.

## How the captures were cleaned

The values below were replaced. Nothing else was changed, apart from formatting with Biome.

- **The project path:** `/work/probe-app`.
- **The home folder:** `/home/user`. Paths derived from the home folder, such as the transcript folder name, were cleaned the same way.
- **The email:** `user@example.com`.
- **IDs:** Cursor's conversation and tool-call IDs became `00000000-0000-4000-8000-00000000000N`, numbered in the order they first appeared.
