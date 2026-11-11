# How Comprende works

Back to the [README](../README.md). Setting up the gate: [The gate for teams](teams.md).

## Requirements

- **Node.js 20+.** Nothing else gets installed: the plugin ships as ready-to-run files that use only Node's built-ins.
- **The [GitHub CLI](https://cli.github.com/)** is optional. `protect` uses it to create the branch rules.

Claude Code itself can run without Node. If `node` is missing or older than 20, Claude tells you so in one line when the session starts, with a link to [nodejs.org](https://nodejs.org). Until then, the hooks step aside and never block a command.

**On Windows**, Claude Code runs hook commands in Git Bash, where these Node checks work. Windows as a whole isn't supported yet (see the limits below). Without Git Bash, Claude Code falls back to PowerShell. There, the Node check at session start fails with a one-time, non-blocking hook error, and the push guard doesn't run, because it's attached to the Bash tool. Install [Git for Windows](https://gitforwindows.org) to get both.

## Explain as you build

- **The skill** (`skills/comprende/SKILL.md`) tells Claude when to explain and how: only code that is new, non-obvious, risky or a real decision, in the user's language.
- **It's on in every session.** At session start, one fixed line reminds Claude to follow the skill whenever it writes or changes code. "add a login endpoint" gets the same treatment as "teach me while you build". Set `COMPRENDE_QUIET=1` to swap it for a quiet one: Claude then explains only when you ask, and the gate isn't affected.
- **Memory.** A small MCP server keeps what you already know in `~/.comprende/` (`COMPRENDE_HOME` moves it), so Claude doesn't explain the same thing twice. It's never committed.

## The gate

### Tying the report to the code

For each changed file, the report records the git blob id of the content that was verified.

If the developer later merges or rebases onto a newer `main`, the gate replays `main`'s edits onto the verified content with a 3-way merge. The report still holds only if the result matches the current content exactly. Any other edit makes the file "stale", and it gets asked about again.

### Four layers

| Layer | What it stops |
|---|---|
| An AI tool's hook (Claude Code, Cursor, Codex) | The agent pushing unverified code |
| A git `pre-push` hook | You pushing unverified code |
| CI on every PR | Merging unverified code |
| A GitHub ruleset | Merging without CI |

The first two catch forgetting. The last two are the lock.

**In Cursor**, the first layer is the Cursor plugin's hook, or the repo's `.cursor/hooks.json`. Cursor also runs Claude Code's hooks (the repo's `.claude/settings.json`, and your Claude Code plugins) while its Third-Party Imports setting is on. However many copies of the hook run, each push is checked once.

**In Codex**, the first layer is the Codex plugin's hook, or the repo's `.codex/hooks.json`, each once trusted in `/hooks`. Codex skips a plugin's hooks after every update until they're trusted again; the repo's keep their trust, and its session start then tells the agent the plugin's hooks were skipped. What works where, and what's weaker in Cursor and Codex: [docs/agents.md](agents.md#what-works-where).

### One file

The whole gate is `gate.mjs`, one bundled file that imports only Node's built-ins (`node:fs`, `node:crypto` and so on). It's copied into each repo, and CI runs the copy on the base branch.

### Safe in repos you don't trust

The plugin only ever runs its own copy of the gate and never executes code from the repo it's looking at. It reads the repo's config as data. It installs the local git hook automatically only when the repo's `gate.mjs` is byte-identical to the plugin's. A copy that differs only in line endings isn't trusted either, and the session says how to fix it. That's why `install` adds `.learning/gate.mjs -text` to `.gitattributes`: git then checks the gate out byte for byte on every platform. Because the gate imports only `node:` built-ins, no file in a repo can stand in for a module it loads. Details: [SECURITY.md](../SECURITY.md).

## Limits, honestly

- **A determined developer can write a report by hand.** The report is a file in their own repo, and nothing outside it can vouch for it. The gate makes skipping deliberate and permanent in git history under their name; it can't make skipping impossible. Treat it as a process tool, not a security boundary. A reviewer reading the summary is part of the system.
- **Local hooks can be bypassed** with `--no-verify`. CI plus the ruleset can't.
- **Code-owner review** means the lead can't approve their own PRs that change the gate. On one-person repos, use `protect --no-code-owners`.
- **Rulesets aren't available for private repos on GitHub's free plan.** Use classic branch protection there.
- **GitHub only for now.**
- **Linux and macOS only for now.** CI tests both with Node 20, 22 and 24. Windows isn't supported yet: an experimental workflow runs the tests there with Git Bash, and some of them fail. 0.2.1 fixed the gate bugs that reached users (CRLF reports, 8.3 short paths, CRLF copies of the gate); the rest are in the test suite. [#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10) lists what fails and why.
