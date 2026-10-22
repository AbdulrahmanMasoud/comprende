# Changelog

## Unreleased

- **Explain-as-you-build is always on:** SessionStart adds one fixed line, under 60 words, in every session. It asks Claude to follow the comprende skill whenever it writes or changes code. Before, the skill only loaded when the request sounded like a wish to learn. `COMPRENDE_QUIET=1` drops the line; gated repos still get the gate message.
- **Missing or old Node.js is reported, never silent:**
  - If `node` isn't on PATH, the SessionStart hook still prints valid JSON. It tells Claude to say, in one line, that Comprende needs Node.js 20+ and where to get it. The check is plain POSIX `sh`.
  - The same note appears when `node` exists but can't run the gate, or when it's older than 20. `session-start` checks `process.versions.node`.
  - The plugin's PreToolUse hook exits 0 when `node` is missing. So does the project-level hook that `install` writes into `.claude/settings.json`; repos installed earlier keep their old command until it's edited. Neither can block Bash by accident.
  - README: what happens on Windows with and without Git Bash.
- **Fixes:**
  - `learning_context` still returns your profile when a project's `.learning/` folder is refused, for example because it's a symlink. Before, the whole call failed.
  - A symlinked `.learning/` is refused with ".learning/ is a symlink". Before, the message said it "resolves outside the project", which was wrong when the link pointed inside the project.
  - A decimal `min_summary_chars` outside the gate's own section of `.learning/config.json`, or in a duplicate key that a later one replaces, no longer makes the whole config invalid.
  - Glob ranges in `sensitive` and `ignore` that mix emoji with characters from U+E000 to U+FFFF now match correctly, and no longer make the config invalid.
  - `install` no longer overwrites `hooks` in `.claude/settings.json` when it has an unexpected shape. It skips the Claude hook and tells you to add it by hand.

## 0.1.0 (first public release)

- **Explain as you build:** Claude explains what it writes, but only where it matters: new APIs, non-obvious logic, hidden coupling, real decisions and risks. Each explanation is short and in your language and dialect, and you can steer it in plain words.
- **Memory:** the learner profile follows you across projects. Per repo, Claude also keeps a project map and records why decisions were made, in `.learning/`.
- **Ownership gate (optional, for teams):**
  - questions while building, plus a final check that always runs before the PR
  - a PR summary written by the developer
  - a report tied to the exact code
- **Enforcement:**
  - a Claude Code hook, a git pre-push hook, and CI with a job summary for reviewers
  - `gate.mjs protect` creates the GitHub ruleset that makes the check required
- **Plugin:**
  - one-step install; the only requirement is Node.js 20+ (no Python, no install step)
  - the local hook is set up automatically in gated repos
- **Node.js only:** written in TypeScript and bundled into dependency-free files. The gate imports only `node:` built-ins.
- **Safe in repos you don't trust:**
  - the plugin never executes repo code
  - the git hook is pinned to a gate.mjs hash and runs exactly the bytes it hashed
  - no commands are taken from the repo's own git config
  - all repo files are read with size limits and without following symlinks
