# Security

## What the ownership gate is and isn't

It is a **process tool**. The gate makes skipping the ownership check deliberate and visible, but it can't make skipping impossible. Things that can get around it:

- **A hand-written report.** The report is a file in the developer's own repo, and nothing outside it can vouch for it. Writing one by hand is possible, and it shows up in git history under the author's name.
- **Bypassed local hooks.** `git push --no-verify` skips them. The binding layer is CI with a required status check: run `gate.py protect`, or set it up by hand.
- **Changes to the gate itself.** These have to be guarded by CODEOWNERS review: `install --owner`, plus "Require review from Code Owners".

Everything else counts as a bug: a way to get **unverified code merged with CI green** while the setup above is in place, or a case where an **honest developer can't get through**. Please report it.

## The plugin in repos you don't trust

The plugin runs in every repo you open with Claude, including ones you just cloned. A malicious repo must not be able to run code on your machine because of it:

- **No repo code in the plugin's hooks or MCP server.** They run only the plugin's own `gate.py`. A repo's `.learning/config.json` is read as data: never through a symlink, at most 256 KB, and strictly validated.
- **The local `pre-push` hook is pinned.** It records the SHA-256 of the `.learning/gate.py` it was installed for. On every push, Python runs isolated (`-I`), so nothing next to `gate.py` can shadow a module. It then executes exactly the bytes it hashed. If `gate.py` later changes (a pull, a checkout), the hook refuses to run it and tells you how to re-trust it.
- **Automatic install only for known code.** The plugin installs that hook automatically only when the repo's `gate.py` is byte-identical to the plugin's own copy, and only into the repo's own `.git/hooks`. It never writes into a custom `core.hooksPath`, which is often shared by every repo on the machine. Set `OWNERSHIP_GATE_NO_AUTO_HOOK=1` to turn auto-install off.
- **No commands from the repo's own git config.** `core.fsmonitor` is forced off for every git call the gate makes. Filter commands (`filter.*.clean/smudge/process`) defined in a repo's own `.git/config` are refused. That only happens when someone hands you a repo as an archive, since a normal clone doesn't carry `.git/config`. Filters you set up globally, like git-lfs, keep working. If the local ones are yours (git-crypt, `git lfs install --local`), set `OWNERSHIP_GATE_TRUST_REPO_CONFIG=1`.
- **The project-level Claude hook** that `gate.py install` adds to `.claude/settings.json` runs the repo's gate (isolated, with `-I`). Claude Code applies it under its normal workspace-trust rules.
- **Notes are data.** Text in `.learning/` is shown to Claude labeled as notes, not instructions, and symlinks there are never followed.
- **Reviewer-facing output is escaped.** The CI job summary escapes PR-author text, so it can't inject HTML, images, links, code spans or table breaks.

## Reporting

Please open a [private security advisory](../../security/advisories/new) instead of a public issue for anything that lets unverified code pass. Include:

- the steps to reproduce
- your git version
- whether the problem shows up locally, in CI, or both
