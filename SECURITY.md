# Security

## What the ownership gate is and isn't

It is a **process tool**. The gate makes skipping the ownership check deliberate and visible, but it can't make skipping impossible. Things that can get around it:

- **A hand-written report.** The report is a file in the developer's own repo, and nothing outside it can vouch for it. Writing one by hand is possible, and it shows up in git history under the author's name.
- **Bypassed local hooks.** `git push --no-verify` skips them. The binding layer is CI with a required status check: run `gate.mjs protect`, or set it up by hand.
- **Changes to the gate itself.** These have to be guarded by CODEOWNERS review: `install --owner`, plus "Require review from Code Owners".

Everything else counts as a bug: a way to get **unverified code merged with CI green** while the setup above is in place, or a case where an **honest developer can't get through**. Please report it.

## The plugin in repos you don't trust

The plugin runs in every repo you open with Claude, including ones you just cloned. A malicious repo must not be able to run code on your machine because of it:

- **No repo code in the plugin's hooks or MCP server.** They run only the plugin's own `dist/gate.mjs`. A repo's `.learning/config.json` is read as data: never through a symlink, at most 256 KB, and strictly validated.
- **The local `pre-push` hook is pinned.** It records the SHA-256 of the `.learning/gate.mjs` it was installed for. On every push, it reads the file, checks the hash, and runs exactly those bytes as an in-memory module. That module can import only Node's `node:` built-ins, so nothing next to `gate.mjs` (no `node_modules`, no `package.json`) can stand in for anything it loads. If `gate.mjs` later changes (a pull, a checkout), the hook refuses to run it and tells you how to re-trust it.
- **Automatic install only for known code.** The plugin installs that hook automatically only when the repo's `gate.mjs` is byte-identical to the plugin's own copy, and only into the repo's own `.git/hooks`. It never writes into a custom `core.hooksPath`, which is often shared by every repo on the machine. Set `OWNERSHIP_GATE_NO_AUTO_HOOK=1` to turn auto-install off.
- **No commands from the repo's own git config.** `core.fsmonitor` is forced off for every git call the gate makes. Filter commands (`filter.*.clean/smudge/process`) defined in a repo's own `.git/config` are refused. That only happens when someone hands you a repo as an archive, since a normal clone doesn't carry `.git/config`. Filters you set up globally, like git-lfs, keep working. If the local ones are yours (git-crypt, `git lfs install --local`), set `OWNERSHIP_GATE_TRUST_REPO_CONFIG=1`.
- **The project-level Claude hook** that `gate.mjs install` adds to `.claude/settings.json` runs the repo's own gate. Claude Code applies it under its normal workspace-trust rules.
- **No code from the environment either.** The pinned hook clears `NODE_OPTIONS` and `NODE_PATH` before running the gate, and the CI step does the same, so nothing can be preloaded into it. The CI workflow restores no dependency cache either.
- **File names are data.** Paths are stored in prototype-free maps and looked up as own keys only, so a file named `__proto__` or `constructor` is an ordinary file to the gate.
- **Hooks fail open, never closed by accident.** A hook only blocks Claude when the gate deliberately returns exit code 2.
  - If `node` isn't on PATH, the plugin's hooks and the project-level hook that `install` writes exit 0. They check with plain POSIX `sh` before starting Node.
  - If Node can't run the gate (a missing file, or a Node too old to load it), SessionStart prints the same note and exits 0. PreToolUse exits 1, which Claude Code treats as a non-blocking error.
  - The hook commands are plain POSIX `sh`, with no syntax that a shell could reject with its own exit code 2.
- **Exemptions are exact.** Only these skip the check:
  - the gate's own files;
  - the report and notes shapes in `.learning/`;
  - `.learning/report.local.json`, at exactly that path and as a plain file;
  - a `.gitignore` edit that adds exactly that one line and nothing else.

  No pattern is exempt, so code can't hide in a look-alike file.
- **Notes are data.** Text in `.learning/` is shown to Claude labeled as notes, not instructions, and symlinks there are never followed.
- **The SessionStart context is fixed text.** The always-on line and the gate messages are constants. The only value read from the repo is the gate's mode, which must be `required`, `suggested` or `off`. File names, branch names and notes never go into it.
- **Reviewer-facing output is escaped.** The CI job summary escapes PR-author text, so it can't inject HTML, images, links, code spans or table breaks.

## Reporting

Please open a [private security advisory](../../security/advisories/new) instead of a public issue for anything that lets unverified code pass. Include:

- the steps to reproduce
- your git version
- whether the problem shows up locally, in CI, or both
