# The ownership gate, for teams

Back to the [README](../README.md). How the gate works inside: [How it works](how-it-works.md).

## Turn it on

Open Claude in the repo and say:

> Enable the ownership gate in this repo.

Claude asks who should own the gate's settings (usually the lead) and opens a PR that adds the gate. Once it's merged, Claude offers to make the check required.

To do the same by hand:

```bash
node <plugin>/dist/gate.mjs install --repo . --owner @your-org/leads
# commit, open a PR, merge it, then make the check required (next section)
```

`install` writes:

- `.learning/gate.mjs`: the gate itself
- `.learning/config.json`: the settings
- `.github/workflows/ownership-check.yml`: the CI check
- `.claude/settings.json`: a hook that stops Claude Code from pushing unverified code (other settings kept)
- `.cursor/hooks.json`: the same for Cursor, plus its session start, as plain `node .learning/gate.mjs … --agent cursor` lines that also run in PowerShell (other hooks kept)
- `.codex/hooks.json`: the same for Codex: a shell hook that finds the repo's root with `git rev-parse`, since Codex may run from a subfolder, and a session start that tells the agent when the plugin isn't running: not installed, or its hooks skipped (other hooks kept). Codex runs them once each developer trusts the project and the hooks in `/hooks`
- `.gitignore`: one line, `.learning/report.local.json`
- `.gitattributes`: one line, `.learning/gate.mjs -text`, so git never rewrites the gate's line endings (on Windows, `core.autocrlf` would)
- CODEOWNERS (with `--owner`): the gate's files need the lead's review.
  - GitHub reads only the first CODEOWNERS it finds: `.github/CODEOWNERS`, then `CODEOWNERS` at the root, then `docs/CODEOWNERS`. `install` adds its lines to that one, keeping its other lines, and creates `.github/CODEOWNERS` only when there's none. So it never hides your own file.
  - When your owners live in the root or `docs/` file, the install PR counts that edit as a change, usually a small one: one question. Only `.github/CODEOWNERS` is one of the gate's own files.
  - A symlinked CODEOWNERS is left alone, and `install` prints the lines to add by hand.
- the local git `pre-push` hook

**Teammates** with the plugin don't need to do anything: their first session in the repo installs their git hook. In Codex, they first trust the project and the hooks in `/hooks`. Teammates without the plugin run `node .learning/gate.mjs install-hooks` once per clone.

### Upgrading the gate

After the plugin updates, upgrade the repo's copy in its own PR:

```bash
node <plugin>/dist/gate.mjs install --upgrade --repo .
```

CI runs the base branch's gate. So when an upgrade brings something the older gate doesn't know yet, CI still checks the upgrade PR the old way. From 0.3.0, the upgrade also adds `.cursor/hooks.json`, and from 0.4.0 `.codex/hooks.json`. Until the base branch runs a gate that knows each as one of its own files, CI counts it as a change: one small-change question, or the skip label. For example, the `.gitattributes` line from 0.2.1 counts as a change until the upgrade is merged: a one-line small change, so one question. Or use the skip label. The local checks follow the same rule, so they never pass what CI then fails. From 0.4.1 the upgrade also adds a session start to `.codex/hooks.json`. A 0.4.0 base already knows that file, so it needs no question, but each Codex user trusts the new hook once in `/hooks`.

## Mixed teams: Claude Code, Cursor and Codex

One repo works for everyone. `install` writes the hooks for each tool, and the report is the same file whichever tool saved it, so CI checks it the same way.

- **Each developer installs the plugin in the tool they use** ([Install](../README.md#install)). Someone with Comprende in Claude Code who also opens Cursor already has it there: Cursor runs Claude Code's plugins while its Third-Party Imports setting is on. Codex doesn't, so it needs its own install.
- **Without the plugin,** the repo's own hook files still stop the agent's push: `.claude/settings.json` in Claude Code, `.cursor/hooks.json` in Cursor, `.codex/hooks.json` in Codex (once trusted). Developers without the plugin run `node .learning/gate.mjs install-hooks` once per clone to get the git hook.
- **Each push is checked once,** whichever hook files and plugins are present ([how](agents.md#step-aside-rules)).
- **Codex users trust the hooks.** Once per repo: the project and the two hooks in its `.codex/hooks.json`. And the plugin's two hooks in `/hooks`, after installing and after every update. Codex skips untrusted hooks without a word, but the repo's session start keeps its trust, so after an update the agent tells you.
- **Repos set up before 0.3.0 or 0.4.0** get `.cursor/hooks.json` and `.codex/hooks.json` with `install --upgrade` ([Upgrading the gate](#upgrading-the-gate)).
- **Cursor's agent signs its commits** with `Co-authored-by: Cursor <cursoragent@cursor.com>`. If the team doesn't want that line, each Cursor user turns off `attribution.attributeCommitsToAgent`.
- **What's weaker** in [Cursor](agents.md#whats-weaker-in-cursor-than-in-claude-code) and in [Codex](agents.md#whats-weaker-in-codex-than-in-claude-code) is listed in docs/agents.md.

## Make the check required

Without this step, CI only warns.

```bash
node .learning/gate.mjs protect            # dry run: shows the GitHub ruleset it would create
node .learning/gate.mjs protect --apply    # creates it; needs admin access and the GitHub CLI (gh)
```

The ruleset applies to the default branch. It requires a pull request with 1 approval, including a code owner, and the **Ownership check** status. It adds to existing branch protection and never replaces it.

- `--approvals N` sets the number of approvals (0 to 10).
- `--no-code-owners` drops the code-owner review. Use it on one-person repos: a code owner can't approve their own PR.

**By hand, or on a private repo on GitHub's free plan** (no rulesets there): Settings → Branches → add a branch protection rule for the default branch. Turn on:

- Require a pull request before merging, and Require review from Code Owners
- Require status checks to pass, with the check **Ownership check**

## Add the Cursor hooks by hand

`install` merges two hooks into `.cursor/hooks.json`. If that file has a shape it doesn't understand, it prints `SKIPPED Cursor hooks` and leaves the file alone. Then add these yourself, keeping `"version": 1` at the top:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      { "matcher": "Shell", "command": "node .learning/gate.mjs agent-hook --agent cursor", "timeout": 60, "failClosed": false }
    ],
    "sessionStart": [
      { "command": "node .learning/gate.mjs session-start --from-repo --agent cursor", "timeout": 30, "failClosed": false }
    ]
  }
}
```

## Add the Claude hook by hand

`install` merges a hook into `.claude/settings.json`. If that file has a shape it doesn't understand, it prints `SKIPPED Claude hook` and leaves the file alone. Then add this entry under `hooks.PreToolUse` yourself:

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "command -v node >/dev/null 2>&1 || exit 0; exec node \"$CLAUDE_PROJECT_DIR/.learning/gate.mjs\" claude-hook",
      "timeout": 60
    }
  ]
}
```

## Add the Codex hook by hand

`install` merges two hooks into `.codex/hooks.json`. If that file has a shape it doesn't understand, it prints `SKIPPED Codex hook` and leaves the file alone. Then add this entry under `hooks.PreToolUse` yourself:

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "node \"$(git rev-parse --show-toplevel)/.learning/gate.mjs\" agent-hook --agent codex",
      "timeout": 60
    }
  ]
}
```

And this one under `hooks.SessionStart`:

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "node \"$(git rev-parse --show-toplevel)/.learning/gate.mjs\" session-start --from-repo --agent codex",
      "timeout": 30
    }
  ]
}
```

Codex runs them once you trust the project, and then the hooks in `/hooks`. The trust lasts across gate and plugin upgrades, since the commands don't change.

## What the developer experiences

- **While building:** after each meaningful piece, Claude asks one or two quick questions, only when that piece had something worth asking. Saying "later" defers them.
- **Before the PR, always:** a final check of 3 to 6 questions, sized to the change's size and risk, not to the person's seniority. It covers:
  - how the parts fit together
  - one or two earlier concepts, asked in a new form
  - every sensitive file
  - a PR summary in the developer's own words

  A wrong answer gets a short explanation and a *different* follow-up question, never the same one again.
- **If they skip it:** Claude won't push, the git hook won't push, and CI won't let the PR merge.

## Small changes

A typo fix or a one-line tweak gets **one** question, and the summary needs only 30 characters. A change counts as small when:

- it adds and removes at most 10 lines, not counting lockfiles and other ignored files
- nothing in it is sensitive, binary or a submodule

The report is still saved and still fingerprints every file.

## Settings: `.learning/config.json`

```json
{"ownership_check": {
  "mode": "required",
  "base": "main",
  "sensitive": ["**/auth/**", "**/payments/**", "**/migrations/**", "**/security/**"],
  "ignore": ["**/package-lock.json", "**/yarn.lock", "..."],
  "min_summary_chars": 80,
  "small_change_lines": 10,
  "small_summary_chars": 30,
  "skip_label": "skip-ownership-check"
}}
```

| Key | What it does |
|---|---|
| `mode` | `required` blocks the merge, `suggested` only warns, `off` turns the gate off |
| `base` | The branch PRs merge into. `install` fills it in; empty means auto-detect |
| `sensitive` | These files must be explicitly verified. Submodule bumps always count as sensitive |
| `ignore` | These files never need questions, but they're still tracked |
| `min_summary_chars` | The shortest PR summary the gate accepts |
| `small_change_lines` | The most added + removed lines for a small change. `0` turns the fast path off |
| `small_summary_chars` | The shortest summary for a small change |
| `skip_label` | The PR label for emergencies (next section) |

**The rules come from the base branch.** CI reads the config and runs the gate from the base branch, so a PR can't switch off its own check. For the same reason, the small-change fast path applies only once the base branch runs a gate that knows it, so local checks and CI always agree.

## Emergencies

Add the `skip-ownership-check` label to the PR. CI skips the check, and the label stays visible in the PR timeline. During an incident, tell Claude it's a hotfix: it keeps quiet while you fix, and runs the check after the fix ships.
