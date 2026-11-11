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
  - A copy that differs only in line endings (CRLF, from git's `core.autocrlf` on Windows) isn't byte-identical, so it isn't trusted either. SessionStart says what the difference is and how to fix it, with fixed text.
  - `install` adds `.learning/gate.mjs -text` to `.gitattributes`, so git checks the gate out byte for byte.
- **No commands from the repo's own git config.** `core.fsmonitor` is forced off for every git call the gate makes. Filter commands (`filter.*.clean/smudge/process`) defined in a repo's own `.git/config` are refused. That only happens when someone hands you a repo as an archive, since a normal clone doesn't carry `.git/config`. Filters you set up globally, like git-lfs, keep working. If the local ones are yours (git-crypt, `git lfs install --local`), set `OWNERSHIP_GATE_TRUST_REPO_CONFIG=1`.
- **The project-level hooks** that `gate.mjs install` adds run the repo's own gate: `.claude/settings.json` for Claude Code, and `.cursor/hooks.json` for Cursor. Each tool applies them under its own workspace-trust rules. Cursor also runs `.claude/settings.json`, while its Third-Party Imports setting is on.
  - A run from the repo's own hook file never installs the git hook. That run is the repo's `gate.mjs`, which can't vouch for itself; only the plugin's copy compares the bytes.
- **Claims can't suppress a check.** When several copies of the hook run on one command, the first to claim it checks (docs/agents.md, "Step-aside rules"). A claim is an empty file in a per-user folder under the system temp folder. The folder must be a real folder, owned by you and private, or nothing is claimed and every copy checks. The ids in a claim (a tool call's, a session's) aren't known in advance, and pruning deletes only claim files.
- **No code from the environment either.** The pinned hook clears `NODE_OPTIONS` and `NODE_PATH` before running the gate, and the CI step does the same, so nothing can be preloaded into it. The CI workflow restores no dependency cache either.
- **File names are data.** Paths are stored in prototype-free maps and looked up as own keys only, so a file named `__proto__` or `constructor` is an ordinary file to the gate.
- **PR text can't take over CI output.** File names, concepts and summaries come from the PR, and a file name can contain a new line. GitHub's runner reads any output line that starts with `::` as a workflow command, so a crafted name could otherwise stop command processing, mask output or set variables.
  - Every message the gate prints in CI is on one line, with control characters escaped (`\n`, `\r`, `\t`, `\xNN`): file names in messages, and errors that quote the PR's report, such as its version.
  - Annotations escape their text the way GitHub's own toolkit does: `%`, `\r` and `\n` in the message, plus `:` and `,` in properties.
  - The job summary escapes markdown and turns new lines into `\n`, so PR text can't add a row, a heading or a line of its own.
- **Hooks fail open, never closed by accident.** A hook only blocks Claude when the gate deliberately returns exit code 2.
  - If `node` isn't on PATH, the Claude Code plugin's hooks and the `.claude/settings.json` hook that `install` writes exit 0. They check with plain POSIX `sh` before starting Node.
  - Cursor's hook commands (`hooks/cursor-hooks.json`, and the `.cursor/hooks.json` that `install` writes) are a plain `node …` line, since Cursor runs hooks in PowerShell on Windows. Without `node` the command fails with the shell's own error code, which isn't 2 in `sh` or in PowerShell (both tested), and `failClosed: false` tells Cursor to let the command run.
  - If Node can't run the gate (a missing file, or a Node too old to load it), SessionStart prints the same note and exits 0. PreToolUse exits 1, which Claude Code and Cursor both treat as a non-blocking error.
  - When PreToolUse allows a command, it prints nothing. Cursor blocks a command when a hook's stdout isn't JSON, so a stray line would block every command.
  - The hook commands have no syntax that a shell could reject with its own exit code 2: plain POSIX `sh` for Claude Code, and no shell syntax at all for Cursor.
  - A usage error in a hook fails open too: an option or a command this gate doesn't know, which a newer hook file might pass to an older copy, gives exit 1 for the AI tools' hooks and 0 for `pre-push`, with one line on stderr. It never gives 2.
- **Exemptions are exact.** Only these skip the check:
  - the gate's own files;
  - the report and notes shapes in `.learning/`;
  - `.learning/report.local.json`, at exactly that path and as a plain file;
  - a `.gitignore` edit that adds exactly that one line and nothing else;
  - a `.gitattributes` edit that adds exactly `.learning/gate.mjs -text` and nothing else, and only once the gate CI runs knows this exemption (it lists `gitattributes` in its header). That line only stops git converting the gate's line endings.

  No pattern is exempt, so code can't hide in a look-alike file.
- **Notes are data.** Text in `.learning/` is shown to Claude labeled as notes, not instructions, and symlinks there are never followed.
- **The SessionStart context is fixed text.** The always-on line and the gate messages are constants. The only value read from the repo is the gate's mode, which must be `required`, `suggested` or `off`. File names, branch names and notes never go into it.
- **Reviewer-facing output is escaped.** The CI job summary escapes PR-author text, so it can't inject HTML, images, links, code spans or table breaks.

## Reporting

Please open a [private security advisory](../../security/advisories/new) instead of a public issue for anything that lets unverified code pass. Include:

- the steps to reproduce
- your git version
- whether the problem shows up locally, in CI, or both
