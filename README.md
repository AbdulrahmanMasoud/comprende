<p align="center"><img src=".claude-plugin/icon.png" width="120" alt=""></p>

<h1 align="center">explain-as-you-build</h1>

<p align="center">
Claude explains the code it writes, briefly and only where it matters.<br>
For teams, an optional <b>ownership gate</b> makes sure the developer who ships a change actually understands it.
</p>

<p align="center"><a href="README.ar.md">العربية</a></p>

---

AI writes code fast. The risk is a developer who asks for a feature, clicks approve and checks that it runs, then merges code they can't explain, change, or debug at 2am. This plugin works on both halves of that problem:

1. **Learn while it builds.** Claude explains each piece as it writes it, but only the parts worth explaining: new APIs, non-obvious logic, hidden coupling, real decisions and risks. Boilerplate gets silence, for juniors and seniors alike. Explanations stay short, in your language and dialect.
2. **Own what you ship (teams).** Before a PR, Claude asks the developer a few sharp questions about *their* change, and the developer writes the PR summary themselves. A report tied to the exact code is saved, and CI refuses the merge without it.

## Install

In Claude Code:

```
/plugin marketplace add YOUR_GITHUB_USER/explain-as-you-build
/plugin install explain-as-you-build@explain-as-you-build
```

You need **Python 3.10+**. You also need [**uv**](https://docs.astral.sh/uv/), which runs the plugin's memory server; without it, everything except that server still works. The [**GitHub CLI**](https://cli.github.com/) is optional: it's used to set up branch rules automatically.

## Using it

Just build things. Claude decides what deserves an explanation. You can steer it in plain words, in any language:

| Say | What happens |
|---|---|
| "explain more", "why?", "اشرح أكتر" | Goes one level deeper on that topic |
| "I know this", "skip", "عارف" | Explains less, and remembers that for the topic |
| "just build", "كمّل ساكت" | Stops explaining until you ask again. Risks are still flagged in one line |
| "check me", "اختبرني" | Runs an ownership check on your current change |

Claude remembers what you already know across projects, so it doesn't explain the same thing twice. This memory lives in `~/.explain-as-you-build/` on your machine and is never committed.

## For teams: the ownership gate

### Turn it on

Open Claude in the repo and say:

> Enable the ownership gate in this repo.

Claude asks who should own the gate's settings (usually the lead), opens a PR that adds the gate, and once it's merged, offers to create the GitHub rule that makes the check required. To do the same by hand:

```bash
python <plugin>/skills/explain-as-you-build/scripts/gate.py install --repo . --owner @your-org/leads
# commit, open a PR, merge it, then:
python .learning/gate.py protect            # dry run: shows the GitHub ruleset it would create
python .learning/gate.py protect --apply    # needs admin; adds to existing branch protection, never replaces it
```

Teammates with the plugin don't need to do anything else: the first time they open Claude in the repo, their local hook is installed. Teammates without it run `python .learning/gate.py install-hooks` once per clone.

### What the developer experiences

- **While building:** after each meaningful piece, Claude asks one or two quick questions, only when that piece had something worth asking. Saying "later" defers them.
- **Before the PR, always:** a short final check of 3 to 6 questions, sized to the change's size and risk, not to the person's seniority. The questions cover:
  - how the parts fit together
  - one or two earlier concepts, asked in a new form
  - every sensitive file
  - a PR summary in the developer's own words

  A wrong answer gets a short explanation and a *different* follow-up question, never the same one again.
- **If they skip it:** Claude won't push, the git hook won't push, and CI won't let the PR merge.

### What the lead sees

On every PR, the **Ownership check** status and a summary on the check's page:

> ## ✅ Ownership check passed
> ### The developer's summary
> > Raised the public API rate limit from 10 to 60 per IP per minute because real users were getting blocked. If the gateway only sees the load balancer's IP, the limit becomes global, so verify X-Forwarded-For in staging first.
>
> | File | Concepts the developer explained |
> |---|---|
> | `src/middleware/rateLimit.js` | per-IP sliding window; window size vs effective limit; X-Forwarded-For behind a load balancer |
> | `src/auth/session.js` 🔒 | token expiry; why refresh is single-use |

The lead **never** sees scores, wrong answers, or how many tries it took. Those stay in the developer's private profile. The goal is ownership, not surveillance.

### Settings: `.learning/config.json`

```json
{"ownership_check": {
  "mode": "required",
  "sensitive": ["**/auth/**", "**/payments/**", "**/migrations/**", "**/security/**"],
  "ignore": ["**/package-lock.json", "**/yarn.lock", "..."],
  "min_summary_chars": 80,
  "skip_label": "skip-ownership-check"
}}
```

- **`mode`:** `required` blocks the merge; `suggested` only warns; `off` turns the gate off.
- **`sensitive`:** these files must be explicitly verified. Submodule bumps always count as sensitive.
- **`ignore`:** these files never need questions, but they're still tracked.
- **Emergencies:** the `skip-ownership-check` label skips the check, and it's visible in the PR timeline.
- **Where the rules come from:** CI reads the config and runs the gate from the **base branch**, so a PR can't switch off its own check.

## How it works

- **Tying the report to the code.** For each changed file, the report records the git blob id of the content that was verified. If the developer later merges or rebases onto a newer `main`, the gate replays `main`'s edits onto the verified content with a 3-way merge. The report still holds only if the result matches the current content exactly. Any other edit is "stale" and gets asked about again.
- **Four layers:**
  - a Claude Code hook that stops Claude from pushing
  - a git `pre-push` hook
  - CI on every PR
  - a GitHub ruleset that makes CI required

  The first two catch forgetting. The last two are the lock.
- **One file.** The whole gate is `gate.py`, a single standard-library Python file. It's copied into each repo, and CI runs the copy on the base branch.
- **Safe in repos you don't trust.** The plugin only ever runs its own copy and never executes code from the repo it's looking at, whose config it reads as data. It installs the local git hook automatically only when the repo's `gate.py` is byte-identical to the plugin's.

## Limits, honestly

- **A determined developer can write a report by hand.** The report is a file in their own repo, and nothing outside it can vouch for it. The gate makes skipping deliberate and permanent in git history under their name; it can't make skipping impossible. Treat it as a process tool, not a security boundary. A reviewer reading the summary is part of the system.
- **Local hooks can be bypassed** with `--no-verify`. CI plus the ruleset can't.
- **Code-owner review** means the lead can't approve their own PRs that change the gate. On one-person repos, use `protect --no-code-owners`.
- **Rulesets aren't available for private repos on GitHub's free plan.** Use classic branch protection there.
- **GitHub only for now.** It's tested on Linux and macOS. On Windows, the hooks call `python3`.

## Repository layout

```
.claude-plugin/       plugin + marketplace manifests, icon
skills/explain-as-you-build/
  SKILL.md            when and how Claude explains
  references/         signals, formats, examples, memory, the ownership-check protocol
  scripts/gate.py     the ownership gate (identical to mcp/src/explain_mcp/gate.py)
hooks/hooks.json      SessionStart (auto-setup) and PreToolUse (block unverified pushes)
.mcp.json             the memory server
mcp/                  the server's source and the test suite
```

## Development

```bash
cd mcp && pip install -e ".[test]"
PYTHONPATH=src:tests pytest -q          # about 125 tests against real git repos
claude plugin validate ./.claude-plugin/plugin.json
```

The tests cover:
- real pushes through the hooks
- a fresh CI-style clone at the PR head
- the workflow's actual shell step
- a regression test for every finding from three independent security reviews

To try a local copy: `claude plugin marketplace add ./` from the repo root.

**Releasing:** `plugin.json` sets `version`, so people who installed the plugin only get an update when it changes. Bump it (and add a CHANGELOG entry) with every release. Users update with `/plugin marketplace update explain-as-you-build`, or by turning on auto-update for this marketplace in `/plugin`.

Issues and PRs are welcome. For security-relevant problems, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
