# How Comprende works

Back to the [README](../README.md). Setting up the gate: [The gate for teams](teams.md).

## Requirements

- **Node.js 20+.** Nothing else gets installed: the plugin ships as ready-to-run files that use only Node's built-ins.
- **The [GitHub CLI](https://cli.github.com/)** is optional. `protect` uses it to create the branch rules.

Claude Code itself can run without Node. If `node` is missing or older than 20, Claude tells you so in one line when the session starts, with a link to [nodejs.org](https://nodejs.org). Until then, the hooks step aside and never block a command.

**On Windows**, Claude Code runs hook commands in Git Bash, where all of this works. Without Git Bash it falls back to PowerShell. There, the Node check at session start fails with a one-time, non-blocking hook error, and the push guard doesn't run, because it's attached to the Bash tool. Install [Git for Windows](https://gitforwindows.org) to get both.

## Explain as you build

- **The skill** (`skills/comprende/SKILL.md`) tells Claude when to explain and how: only code that is new, non-obvious, risky or a real decision, in the user's language.
- **It's on in every session.** At session start, one fixed line reminds Claude to follow the skill whenever it writes or changes code. "add a login endpoint" gets the same treatment as "teach me while you build". Set `COMPRENDE_QUIET=1` to drop that line. The skill still loads when you ask for explanations, and the gate isn't affected.
- **Memory.** A small MCP server keeps what you already know in `~/.comprende/` (`COMPRENDE_HOME` moves it), so Claude doesn't explain the same thing twice. It's never committed.

## The gate

### Tying the report to the code

For each changed file, the report records the git blob id of the content that was verified.

If the developer later merges or rebases onto a newer `main`, the gate replays `main`'s edits onto the verified content with a 3-way merge. The report still holds only if the result matches the current content exactly. Any other edit makes the file "stale", and it gets asked about again.

### Four layers

| Layer | What it stops |
|---|---|
| A Claude Code hook | Claude pushing unverified code |
| A git `pre-push` hook | You pushing unverified code |
| CI on every PR | Merging unverified code |
| A GitHub ruleset | Merging without CI |

The first two catch forgetting. The last two are the lock.

### One file

The whole gate is `gate.mjs`, one bundled file that imports only Node's built-ins (`node:fs`, `node:crypto` and so on). It's copied into each repo, and CI runs the copy on the base branch.

### Safe in repos you don't trust

The plugin only ever runs its own copy of the gate and never executes code from the repo it's looking at. It reads the repo's config as data. It installs the local git hook automatically only when the repo's `gate.mjs` is byte-identical to the plugin's. Because the gate imports only `node:` built-ins, no file in a repo can stand in for a module it loads. Details: [SECURITY.md](../SECURITY.md).

### Questions leave a trace

Each question Claude asks during the check is logged with the `record_answer` tool: the file, the concept, the question type, the question and the verdict, never the answer. The log stays in `~/.comprende/evidence/` on the developer's machine. When the report is saved, it gets only the number of questions and a SHA-256 digest of the log, and CI shows reviewers that count. A report saved without any logged questions still passes, but CI warns the reviewer.

## Limits, honestly

- **A determined developer can write a report by hand**, or log questions that were never asked. The report is a file in their own repo, and nothing outside it can vouch for it. The gate makes skipping deliberate and permanent in git history under their name; it can't make skipping impossible. Treat it as a process tool, not a security boundary. A reviewer reading the summary is part of the system.
- **Local hooks can be bypassed** with `--no-verify`. CI plus the ruleset can't.
- **Code-owner review** means the lead can't approve their own PRs that change the gate. On one-person repos, use `protect --no-code-owners`.
- **Rulesets aren't available for private repos on GitHub's free plan.** Use classic branch protection there.
- **GitHub only for now.** CI tests it on Linux and macOS with Node 20, 22 and 24. Windows should work with Node and Git for Windows (Git Bash), but it isn't tested yet.
