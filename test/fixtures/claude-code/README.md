# Claude Code hook payloads

Real hook input from Claude Code, captured on 2026-11-11 with Claude Code `2.1.322` on macOS, in headless mode (`claude -p --model haiku`). Each file is the JSON a hook read on stdin, except `hook-env.json`. The hooks were registered in a throwaway repo's `.claude/settings.json`.

Don't write these by hand. To change one, capture it again from a real run.

| File | The hook and the case |
|---|---|
| `session-start.json` | `SessionStart`, at the start of a new session (`source: "startup"`) |
| `pre-tool-use.bash.git-push.json` | `PreToolUse` (`"matcher": "Bash"`) before `git push origin feature/probe` |
| `pre-tool-use.bash.git-status.json` | `PreToolUse` before `git status` |
| `pre-tool-use.bash.ls.json` | `PreToolUse` before `ls` |
| `pre-tool-use.read.json` | `PreToolUse` (`"matcher": "Read"`) before the Read tool |
| `hook-env.json` | `CLAUDE_PROJECT_DIR`, the one project variable a hook got |

Things to know:

- `cwd` is the project root, so the repo comes from the payload. Tests swap `/work/probe-app` for their own repo.
- Compare [`../cursor/`](../cursor/): Cursor runs the same hook commands, but sends `tool_name: "Shell"`, `hook_event_name: "preToolUse"` and `cwd: ""`.

## How the captures were cleaned

The values below were replaced. Nothing else was changed, apart from formatting with Biome.

- **The project path:** `/work/probe-app`.
- **The home folder:** `/home/user`. Paths derived from the home folder, such as the transcript folder name, were cleaned the same way.
- **IDs:** session and prompt IDs became `00000000-0000-4000-8000-00000000000N`, numbered in the order they first appeared, and `tool_use_id` became `toolu_000000000000000000000000`.
