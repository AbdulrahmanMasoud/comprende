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
- `.claude/settings.json`: a hook that stops Claude from pushing unverified code (other settings kept)
- `.gitignore`: one line, `.learning/report.local.json`
- `.github/CODEOWNERS`: the gate's files need the lead's review (with `--owner`)
- the local git `pre-push` hook

**Teammates** with the plugin don't need to do anything: their first session in the repo installs their git hook. Teammates without the plugin run `node .learning/gate.mjs install-hooks` once per clone.

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
