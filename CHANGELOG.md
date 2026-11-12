# Changelog

## Unreleased

- **Antigravity: a hook that fails no longer blocks every command.** Antigravity blocks a command when a hook exits non-zero, prints anything but JSON, or times out, though its docs say a failed hook fails open. Comprende's hooks exit 1 when they can't run, which is "skip this hook" in Claude Code. So in Antigravity, a crash, or a Node.js that can't load `gate.mjs`, would have blocked every command. Found in the first signed-in run ([recording](docs/recordings/antigravity/)).
  - **Comprende now has its own Antigravity plugin files:** `.antigravity-plugin/plugin.json`, a root `hooks.json` and a root `mcp_config.json`. `agy plugin install` uses them instead of converting the Claude Code plugin. Their hook commands exit 0 with nothing on stdout whenever the gate fails, even without `node`. Tested in the real Antigravity CLI: without `node`, without `gate.mjs`, and after a crash with partial output, the command ran. The skill and the memory server work as before.
  - **To get it:** run `agy plugin install https://github.com/AbdulrahmanMasoud/comprende` again. It replaces the converted copy.
  - **Not yet:** the push check in Antigravity comes in 0.5.0. Git's `pre-push` hook and CI still check.
  - **On Windows,** which shell Antigravity runs hooks in isn't documented. The new commands exit 0 with nothing on stdout in `cmd.exe` and both PowerShells (tested outside Antigravity), so they don't block there, and don't check anything either. Windows stays experimental ([#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10)).

## 0.4.2

- **Codex: the repo's note no longer tells a teammate without the plugin to trust its hooks again.** In a real run with only the repo's `.codex/hooks.json`, the agent told the user to re-trust hooks they never had, and not how to install the plugin. The note now says the plugin isn't running, either not installed or its hooks skipped, and has the agent give both options in one line: install it, or trust its hooks in `/hooks`. Tested in the real Codex CLI ([recording](docs/recordings/codex/0.4.2/)). The note comes from the repo's own `.learning/gate.mjs`, so teams get it with `install --upgrade`. The hook's command is unchanged.

## 0.4.1

- **Codex: after a plugin update, the agent now tells you to trust Comprende's hooks again.** Codex skips a plugin's hooks without a word after every update. In 0.4.0 the skill was to notice, but in two real runs Codex's agent didn't open the skill for a small code change. Now `install` gives the repo's `.codex/hooks.json` a session start too. Its trust lasts across plugin updates, so it still runs, and tells the agent what to say. Each Codex user trusts it once in `/hooks`, after `install --upgrade`. Tested in the real Codex CLI ([recording](docs/recordings/codex/0.4.1-after-update/)).
  - With both trusted, the plugin's and the repo's session starts share one claim for the gate's message, so it comes once.
  - **The skill loads for any code change in every tool**, as the always-on line already asked. With no session-start note, it checks for the gate with one exact command, since an agent's file search can skip the hidden `.learning/`.
  - **`COMPRENDE_QUIET=1`** now swaps the always-on line for a quiet one, so the skill still explains only when asked.

## 0.4.0

- **Codex support** ([#3](https://github.com/AbdulrahmanMasoud/comprende/issues/3)). Comprende runs in Codex: the skill, the memory server, the always-on line and the push guard, from a Codex plugin (`.codex-plugin/`) or the repo's own `.codex/hooks.json`. To install: `codex plugin marketplace add AbdulrahmanMasoud/comprende`, then `codex plugin add comprende@comprende`, then trust its hooks in `/hooks` ([README](README.md#codex)).
  - **Trust the hooks again after every update.** Codex skips a plugin's hooks without a word until they're trusted again. The repo's `.codex/hooks.json` keeps its trust. In a gated repo, the skill tells the agent to mention it when the session got no Comprende note (not yet confirmed in Codex).
  - **Windows is experimental** ([#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10)): PowerShell turns a block's exit 2 into 1, so in Cursor and Codex on Windows the push guard fails open. The git hook and CI still check.
  - What works where, what's weaker in Codex, and a checklist to try it by hand: [docs/agents.md](docs/agents.md#what-works-where). Mixed teams: [docs/teams.md](docs/teams.md#mixed-teams-claude-code-cursor-and-codex).
- **`install` writes `.codex/hooks.json` too** (part of [#3](https://github.com/AbdulrahmanMasoud/comprende/issues/3)): the gate's shell hook for teammates on Codex. Its command finds the repo's root with `git rev-parse`, since Codex may run from a subfolder, and it fails open without `git` or `node`. Each developer trusts the project and the hook once in Codex. The trust lasts across gate upgrades, since the command doesn't change. `install` merges it into an existing file, and `install --upgrade` adds it.
  - **Upgrading:** until the base branch runs a gate that knows `.codex/hooks.json` as one of its own files (the `codex-hooks` feature), CI counts the new file as a change: one small-change question, or the skip label.
  - **One check per push in Codex, too:** the plugin and `.codex/hooks.json` claim the push, and only the first checks it.
- **`tools/e2e-codex.mjs`:** the end-to-end run in the real Codex CLI, by hand (CONTRIBUTING.md, "Testing in Codex"). Its real replies are kept in `docs/recordings/codex/`.
- **The skill loads for any code change in a gated repo** (one with `.learning/config.json`), not only when the user wants to learn. In Codex, with the hooks skipped, nothing else made it load, so its "no session-start note" rule couldn't fire.

- **A Codex plugin** (part of [#3](https://github.com/AbdulrahmanMasoud/comprende/issues/3)): `.codex-plugin/plugin.json`, which Codex reads before `.claude-plugin/`, with the same skill.
  - **Its hooks,** in `hooks/codex-hooks.json`, pass `--agent codex`. They're plain `node` lines, so they also run in PowerShell, and a missing `node` fails open.
  - **The memory server now starts in Codex,** all 10 tools. Codex doesn't expand `${CLAUDE_PLUGIN_ROOT}` in a plugin's MCP config, so Codex gets its own, with a relative path.
  - `tools/release.mjs` keeps its version in step. A consistency test checks that Claude Code, Cursor, Codex and Antigravity each find only their own manifest, hooks and MCP config.
- **The skill notices hooks that didn't run.** When a session starts in a gated repo without Comprende's session-start note, the agent says so once, in one line: in Codex, trust the hooks again in `/hooks` (after every plugin update, Codex skips them until they're trusted again); elsewhere, check that the plugin is enabled. Not yet confirmed in Codex: the recorded run shows the agent didn't load the skill for a plain code task before the skill's description named gated repos.
- **Codex: the gate's hook knows Codex** (part of [#3](https://github.com/AbdulrahmanMasoud/comprende/issues/3)). Codex installs Comprende's Claude Code plugin as it is, and runs its hooks. The hook read Codex's payload as Claude Code's, so it stepped aside for the repo's `.claude/settings.json`, which Codex never runs, and left the agent's push to the git hook. It now detects Codex from the tool call's `turn_id`, checks the push, and the block says "Ask Codex …".
- **A hook never blocks by accident.** Only a verdict on the change blocks a push: no report, a file that isn't verified, or a report that's there but can't be read (broken, or too large). Before, a git failure during the check or a broken `.learning/config.json` blocked the agent's push too, and the git hook blocked on any unexpected error. Now they let the push run, and the git hook skips the branch with a note. CI still checks.
  - A report made by another gate version still blocks git's hook, which runs the repo's own gate. It no longer blocks the agents' hook, where the plugin's copy may simply be newer than the repo's.

## 0.3.0

- **Cursor support** ([#2](https://github.com/AbdulrahmanMasoud/comprende/issues/2)). Comprende runs in Cursor: the skill, the memory server, the always-on line and the push guard, from a Cursor plugin or from the repo's own `.cursor/hooks.json`. To install it, clone it into `~/.cursor/plugins/local/comprende` ([README](README.md#cursor)).
  - **Install it in one place.** Cursor also runs your Claude Code plugins, so with both the skill loads twice.
  - **Windows is experimental** ([#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10)): untested in Cursor, which runs hooks in PowerShell.
  - What works where, what's weaker in Cursor, and a checklist for the IDE: [docs/agents.md](docs/agents.md#what-works-where). Mixed teams: [docs/teams.md](docs/teams.md#mixed-teams-claude-code-cursor-and-codex).
- **JSON that starts with a UTF-8 BOM is read like any other**, in a hook's payload and in `save --input`. Cursor's CLI on Windows has sent a payload with one. The hook then stepped aside: the push went unchecked, and the session got no gate context. PowerShell 5.1 writes files with one, and `save --input` then refused the report as invalid JSON.
- **`install` writes `.cursor/hooks.json` too** (part of [#2](https://github.com/AbdulrahmanMasoud/comprende/issues/2)): the gate's shell hook and session start for teammates on Cursor, as plain `node .learning/gate.mjs … --agent cursor` lines that also run in PowerShell. It merges into an existing file, keeping its hooks, and `install --upgrade` adds it to repos that already have the gate.
  - **Upgrading:** until the base branch runs a gate that knows `.cursor/hooks.json` as one of its own files (the `cursor-hooks` feature), CI counts the new file as a change. The upgrade PR needs one small-change question, or the skip label.
- **One check per push, wherever the hooks come from.** A copy of the hook steps aside for a repo hook file the tool always runs: `.cursor/hooks.json` in Cursor, `.claude/settings.json` in Claude Code. The copies left claim the push, and only the first checks it. In Cursor these are the plugins, and `.claude/settings.json` while Third-Party Imports is on. Each session gets the always-on line once, and the gate's context once. Only a plugin installs the git hook, never a run of the repo's own `gate.mjs`.
- **A Cursor plugin** (part of [#2](https://github.com/AbdulrahmanMasoud/comprende/issues/2)): `.cursor-plugin/plugin.json`, next to Claude Code's, with the same skill and the same memory server (all 10 tools). Its hooks, in `hooks/cursor-hooks.json`, are plain `node` lines with no shell syntax, so they also run in PowerShell, and a missing `node` fails open. `tools/release.mjs` keeps its version in step.
- **The skill reads the same in both tools:** where it said "Claude" but meant the agent, it now says so.
- **Cursor: the gate's hook reads the repo from the payload** (part of [#2](https://github.com/AbdulrahmanMasoud/comprende/issues/2)). In Cursor it uses the workspace's one root, then Cursor's project variables, and steps aside when it can't tell, instead of guessing from its own folder, since Cursor runs a plugin's hooks from the plugin's folder. With several workspace roots it steps aside too, because the command may run in any of them. The git hook and CI still check.
- **Messages name the tool you're in:** "Ask Claude to run the ownership check" in Claude Code, "Ask Cursor …" in Cursor, and "Ask your AI assistant …" in CI and the git hook. The Node.js note at session start names the app to restart, the plugin-update hint covers both tools, and `hooks/hooks.json`'s own note for a missing `node` names both apps, since Cursor runs it too.

## 0.2.3

**Upgrading:** update the plugin, then upgrade the repo's copy of the gate in its own PR, with `node <plugin>/dist/gate.mjs install --upgrade --repo .` (see [Upgrading the gate](docs/teams.md#upgrading-the-gate)). The upgrade PR needs no report. The CI fix (#32) applies once the base branch runs the new copy, and the hook fix (#30) once the repo's copy and the plugin are updated. `GATE_VERSION` stays 3, since the report format is unchanged.

- **`install --owner` no longer hides your CODEOWNERS** ([#33](https://github.com/AbdulrahmanMasoud/comprende/issues/33)). GitHub reads only the first CODEOWNERS it finds (`.github/`, then the root, then `docs/`). `install` always wrote `.github/CODEOWNERS`, so a repo whose owners lived in a root or `docs/` file lost all those rules. It now adds its lines to the file GitHub reads, and creates `.github/CODEOWNERS` only when there's none.
- **A usage error in a hook no longer blocks every command** ([#30](https://github.com/AbdulrahmanMasoud/comprende/issues/30)). An unknown option, an option missing its value, or an unknown command exited 2, which Claude Code and Cursor read as "block". The hook entry points now fail open with one line on stderr: exit 1 for `agent-hook`, `claude-hook` and `session-start`, and 0 for `pre-push`, since git blocks a push on any non-zero exit. An unknown command now exits 1 for every caller, since it may be a newer hook entry point. Other commands keep exit 2 for a usage error.
- **CI: PR text can't inject a workflow command** ([#32](https://github.com/AbdulrahmanMasoud/comprende/issues/32)). A file name with a new line followed by `::` could start a GitHub workflow command of its own, in the gate's output or its annotations. Every message verify prints is now on one line, with control characters escaped (file names, and errors that quote the PR's report), annotations escape `%`, `\r`, `\n` (and `:`, `,` in properties) as GitHub's toolkit does, and the job summary turns new lines into `\n`. CI runs the base branch's gate, so this applies once the repo's copy is upgraded.
- **`agent-hook`:** the gate's hook command now has a name that doesn't depend on the tool, and `--agent <id>` names the tool running it. `claude-hook` is the same command and keeps working, so existing repos need no change. Inside, each AI tool's hook payloads are read by its own adapter, starting with Claude Code and Cursor ([#18](https://github.com/AbdulrahmanMasoud/comprende/issues/18)). GitHub's side (the CI workflow, the reviewer summary, CODEOWNERS and `protect`) sits behind a platform adapter the same way, ready for GitLab ([#4](https://github.com/AbdulrahmanMasoud/comprende/issues/4)).
- **Contributions:** Comprende isn't accepting outside pull requests for now. Issues, feature requests and feedback are welcome. See [Contributions](CONTRIBUTING.md#contributions).
- **Docs:** [docs/agents.md](docs/agents.md) has what we tested about Cursor, and a design for Cursor support and agent adapters ([#2](https://github.com/AbdulrahmanMasoud/comprende/issues/2)).

## 0.2.2

**Upgrading:** update the plugin, then upgrade the repo's copy of the gate in its own PR, with `node <plugin>/dist/gate.mjs install --upgrade --repo .` (see [Upgrading the gate](docs/teams.md#upgrading-the-gate)). The upgrade PR needs no report. Cursor users get the fix only once it's merged: the repo's Claude hook runs the repo's own copy, and the plugin's hook steps aside while the repo has its own. `GATE_VERSION` stays 3, since the report format is unchanged.

- **Cursor: the Claude hook now blocks unverified pushes** ([#17](https://github.com/AbdulrahmanMasoud/comprende/issues/17)).
  - Cursor runs Claude Code's hooks: the repo's `.claude/settings.json`, and the hooks of the Claude Code plugins you've installed. But it reports its shell tool as `Shell`, not `Bash`. The hook checked only for `Bash`, so in Cursor it let every push through, including `git push --no-verify`. The git pre-push hook and CI weren't affected.
  - The hook now accepts both names. When it allows a command, it still prints nothing, because Cursor blocks a command when a hook's stdout isn't JSON.
  - The tests use payloads captured from real Cursor runs, in `test/fixtures/cursor/`.
- **CI:** `claude plugin validate` now runs on Claude Code 2.1.322 ([#20](https://github.com/AbdulrahmanMasoud/comprende/pull/20)).

## 0.2.1

**Upgrading:** in its own PR, run the plugin's copy of the gate: `node <plugin>/dist/gate.mjs install --upgrade --repo .` (see [Upgrading the gate](docs/teams.md#upgrading-the-gate)). The repo's own copy can't replace itself: `node .learning/gate.mjs install --upgrade` only reports `.learning/gate.mjs is this file`.
- It replaces the gate and adds one line, `.learning/gate.mjs -text`, to `.gitattributes`.
- While the base branch still runs the older gate, CI counts that line as a change, so the upgrade PR needs one check: a small change, so one question. Or use the skip label.
- Once the upgrade is merged, the line needs no report.
- `GATE_VERSION` stays 3:
  - The report format is unchanged, so old and new gates still read each other's reports.
  - The new exemption is offered only when the gate CI runs lists it (`// ownership-gate-features: small-change gitattributes`), so local and CI agree, as with the fast path in 0.2.0.

- **Fixes for Windows**, from [#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10):
  - **Reports with CRLF line endings parse again.**
    - A report checked out by git's `core.autocrlf`, or saved by a Windows editor, read as having no data block, so every file showed as new and needed its questions again (after a rebase, say).
    - The parser now accepts LF and CRLF on every platform. The gate still writes LF.
  - **`save --input` deletes `.learning/report.local.json` behind 8.3 short names.**
    - It compared the input path with the repo root as strings. The two didn't match when one came through a short name (`C:\Users\RUNNER~1\…`), so the file was kept.
    - It now resolves both with the native `realpath`, which expands short names, and compares them ignoring letter case on Windows.
  - **A CRLF copy of `.learning/gate.mjs` no longer silently loses the pre-push hook.**
    - git's `core.autocrlf` checked the gate out with CRLF on Windows, so it was never byte-identical to the plugin's copy, and SessionStart didn't install the hook.
    - `install` now adds `.learning/gate.mjs -text` to `.gitattributes`, appended once and keeping the file's other lines, so git checks the gate out byte for byte.
    - The plugin's own repo has a `.gitattributes` that does the same for `dist/` and the skill's scripts.
    - When the only difference between the copies is line endings, SessionStart and `install` now say so, and how to fix it: `git -c core.autocrlf=false checkout -- .learning/gate.mjs`, or an update for an older plugin install. Before, the message only said the copies differ.
- **The MCP server reports the plugin's version.** It still said 0.2.0. `build.mjs` now sets it from `package.json`, and a test checks it against `plugin.json`.
- **Contributing:** every change now goes through a branch, a pull request and CI, and `main` is protected. [CONTRIBUTING.md](CONTRIBUTING.md) has the workflow, the commit format, how versions are chosen and the code rules.
- **CI:**
  - lint, typecheck and the `dist/` check now run once, in their own job, instead of in each of the six test jobs
  - a new Consistency job checks that `plugin.json`, `package.json`, `package-lock.json` and this file agree on the version, runs `claude plugin validate` on both manifests, and runs actionlint on the workflows
  - a separate "Windows (experimental)" workflow runs the tests on Windows (Node 22, Git Bash) on pushes to `main`, weekly and by hand. It never runs on PRs and isn't required. [#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10) lists what fails there.
- **Releases:** pushing a tag `vX.Y.Z` on `main` checks it against the version files, runs CI, and publishes the GitHub Release with that version's notes from this file.
- Dependabot, and templates for PRs, bug reports and feature requests.
- **Dev dependencies:**
  - `@types/node` now targets Node 20, the oldest Node in `engines.node`, so typecheck rejects newer APIs. Dependabot skips its major updates, and a test keeps it in step with `engines.node`.
  - `body-parser` is overridden to `^2.4.0` for [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828). It's a dev-only dependency of the MCP SDK and isn't in `dist/`.

## 0.2.0

**Upgrading:** once a repo upgrades its gate (`gate.mjs install --upgrade`, merged into the base branch), the fast path for small changes is on by default, even if `.learning/config.json` doesn't list the new keys yet. To keep the old behaviour, set `"small_change_lines": 0`.

- **A README you can follow:** a link to the overview video (`https://youtu.be/KeoRSyM0zu8`); install from the terminal (user scope, so it's on in every project) and how to check it worked; then each part as steps, with real Claude sessions (shortened) as examples; and a "Try it in 5 minutes" script that a test runs. The details moved to `docs/teams.md` (setting up the gate, settings, small changes, emergencies), `docs/how-it-works.md` (requirements, internals, honest limits) and `CONTRIBUTING.md`. README.ar.md mirrors it, with sessions recorded in Arabic.
- **Terminal demo:** `docs/demo.gif`, embedded in both READMEs, shows a push being blocked, a report being saved and the push going through, in about 25 seconds. It's rendered with [VHS](https://github.com/charmbracelet/vhs) from `docs/demo.tape` (`vhs docs/demo.tape`). A test runs the same commands, so the demo stays true.
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
- **CI workflows on Node 24:** the workflow `install` writes uses `actions/checkout@v7` and `actions/setup-node@v7` (both on Node 24), runs the gate on Node 24, and turns off setup-node's dependency cache (`package-manager-cache: false`), since the gate needs no dependencies and a restored cache could be poisoned. Repos installed earlier keep their workflow until `install --upgrade` and a hand edit, or a fresh install. This repo's own CI uses the same action versions.
- **Fixes:**
  - The gate's "do it by hand" messages (no `gh`, no rulesets on GitHub's free plan, a `.claude/settings.json` that `install` can't merge into) link to the matching section of `docs/teams.md`. One of them pointed at a README section that didn't exist.
  - The submodule test stages its bump with `git add --force`: newer git (2.55+) no longer stages a submodule marked `ignore = all` through `git add -A`. The gate itself was unaffected: it reads committed diffs with `--ignore-submodules=none`.
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
