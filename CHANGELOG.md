# Changelog

## 0.2.0

**Upgrading:** once a repo upgrades its gate (`gate.mjs install --upgrade`, merged into the base branch), the fast path for small changes is on by default, even if `.learning/config.json` doesn't list the new keys yet. To keep the old behaviour, set `"small_change_lines": 0`.

- **README opens with a Quick start:** three short paths, for a solo developer, a team lead and a team member. The same section is in README.ar.md.
- **Terminal demo:** `docs/demo.gif`, embedded in both READMEs, shows a push being blocked, a report being saved and the push going through. It's rendered with [VHS](https://github.com/charmbracelet/vhs) from `docs/demo.tape` (`vhs docs/demo.tape`). A test runs the same commands, so the demo stays true.
- **A fast path for small changes:**
  - **New config keys:** `small_change_lines` (default 10, `0` turns it off) and `small_summary_chars` (default 30).
  - **What counts as small:** the change adds and removes at most `small_change_lines` lines across its non-ignored files, counted with `git diff --numstat` from the fork point. It also has no sensitive file, no submodule and no binary file.
  - **What it changes:** `save` and `verify` accept a summary of `small_summary_chars` instead of `min_summary_chars`, and the protocol asks one question instead of 3–6. Everything else is unchanged: there's still a report that fingerprints every file and needs at least one verified file.
  - **Status:** `status` prints "Small change (N changed lines)". `--json` has `small_change`, `changed_lines` and the `min_summary_chars` that applies.
  - **Validation:** the new keys must be non-negative integers, like `min_summary_chars`.
  - **Compatibility, and why `GATE_VERSION` stays 3:**
    - CI runs the base branch's gate. A new gate that offers the fast path while the base still runs an older gate would let a developer save a 30-character summary that CI then rejects.
    - Bumping `GATE_VERSION` doesn't fix that. Gates accept only reports of their own version, so every old gate would reject every new report and the reverse, forcing plugin and repo upgrades in lockstep.
    - Instead, `gate.mjs` now lists its features in its header (`// ownership-gate-features: small-change`). The fast path applies only when the base branch's `gate.mjs` lists it. Otherwise `status` explains why the change needs the full check.
    - The report format is unchanged, so old and new gates keep reading each other's reports.
    - With an older plugin in a repo whose gate has the fast path, the plugin stays stricter (always `min_summary_chars`). It's never more lenient than CI.
- **Explain-as-you-build is always on:** SessionStart adds one fixed line, under 60 words, in every session. It asks Claude to follow the comprende skill whenever it writes or changes code. Before, the skill only loaded when the request sounded like a wish to learn. `COMPRENDE_QUIET=1` drops the line; gated repos still get the gate message.
- **Missing or old Node.js is reported, never silent:**
  - If `node` isn't on PATH, the SessionStart hook still prints valid JSON. It tells Claude to say, in one line, that Comprende needs Node.js 20+ and where to get it. The check is plain POSIX `sh`.
  - The same note appears when `node` exists but can't run the gate, or when it's older than 20. `session-start` checks `process.versions.node`.
  - The plugin's PreToolUse hook exits 0 when `node` is missing. So does the project-level hook that `install` writes into `.claude/settings.json`; repos installed earlier keep their old command until it's edited. Neither can block Bash by accident.
  - README: what happens on Windows with and without Git Bash.
- **Internal: plain TypeScript, no Python imitation.** The code no longer copies the semantics of the unpublished Python prototype. User-visible rules are kept and documented on their own terms: glob matching, summary length in characters, and strict config validation.
  - `profile.json` is plain JSON now, as written by `JSON.stringify`. A hand-edited value of the wrong type falls back to its default instead of making every tool fail, and a profile that isn't valid UTF-8 is kept as `profile.broken-<date>.json`, like invalid JSON.
  - `repo_root` and `COMPRENDE_HOME` still expand `~`, but no longer `~otheruser`.
- **Fixes:**
  - The gate's hint says `("check me")` without the Arabic phrase, which terminals draw with its letters reversed. In conversation the skill still understands the phrase in any language.
  - `status` and `save` say "1 changed line" and "1 file fingerprinted" instead of "1 changed lines" and "1 files fingerprinted".
  - When the Claude hook blocks a push and a valid report is saved but not committed, it now says so: commit it first, then push as a separate command. The hook checks the branch before a command runs, so `git commit … && git push` in one command used to fail with a confusing "No ownership report". The protocol now tells Claude to push separately.
  - **Saving without the MCP tool** has one documented route. Write the JSON to `.learning/report.local.json` and run `gate.mjs save --input .learning/report.local.json`. Never use a heredoc, which Claude Code's shell checks can block, and never any other file.
    - The gate treats exactly that path, as a plain file (mode 100644), as plumbing. A look-alike such as `.learning/x.local.json` is still checked.
    - `install` adds the path to `.gitignore`, keeping existing lines.
    - A `.gitignore` edit counts as plumbing only when it adds exactly that one line, so the PR that installs the gate still needs no report.
    - A successful `save --input` deletes the file. A failed one leaves it, and no other input file is ever deleted.
    - Why not `.git/`: Claude Code won't let Claude write there, even with an allow rule.
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
