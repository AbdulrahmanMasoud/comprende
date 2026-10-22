# Changelog

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
