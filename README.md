<p align="center"><img src=".claude-plugin/icon.png" width="120" alt=""></p>

<h1 align="center">Comprende</h1>

<p align="center"><b>Proof of understanding for AI-written code.</b></p>

<p align="center">
AI writes the code. Comprende makes sure you understand it.<br>
Claude explains the code it writes, briefly and only where it matters.<br>
For teams, an optional <b>ownership gate</b> makes sure the developer who ships a change actually understands it.
</p>

<p align="center"><a href="README.ar.md">العربية</a></p>

## Quick start

**Solo developer.** Two commands in Claude Code, nothing to configure:

```
/plugin marketplace add AbdulrahmanMasoud/comprende
/plugin install comprende@comprende
```

Then build as usual. Claude explains what's worth explaining, briefly, in your language. You need Node.js 20+.

**Team lead.** Install the plugin, open Claude in your repo and say:

> Enable the ownership gate in this repo.

Claude opens a PR that adds the gate. Review `.learning/config.json` in it, mainly the `sensitive` globs, and merge. Then run `node .learning/gate.mjs protect --apply`, or ask Claude to, so the check is required on your default branch.

**Team member.** Install the plugin with the two commands above. That's it: your first session in the repo sets up the local hook, and Claude runs the check with you before you push.

![In a terminal: the ownership gate blocks a push, a report is saved, then the push goes through](docs/demo.gif)

The demo is recorded with [VHS](https://github.com/charmbracelet/vhs) from [`docs/demo.tape`](docs/demo.tape). Run `vhs docs/demo.tape` to render it again.

---

AI writes code fast. The risk is a developer who asks for a feature, clicks approve and checks that it runs, then merges code they can't explain, change, or debug at 2am. This plugin works on both halves of that problem:

1. **Learn while it builds.** Claude explains each piece as it writes it, but only the parts worth explaining: new APIs, non-obvious logic, hidden coupling, real decisions and risks. Boilerplate gets silence, for juniors and seniors alike. Explanations stay short, in your language and dialect.
2. **Own what you ship (teams).** Before a PR, Claude asks the developer a few sharp questions about *their* change, and the developer writes the PR summary themselves. A report tied to the exact code is saved, and CI refuses the merge without it.

## Install

In Claude Code:

```
/plugin marketplace add AbdulrahmanMasoud/comprende
/plugin install comprende@comprende
```

The only requirement is **Node.js 20+**. Nothing else gets installed: the plugin ships as ready-to-run files that use only Node's built-ins. The [**GitHub CLI**](https://cli.github.com/) is optional: it's used to set up branch rules automatically.

Claude Code itself can be installed without Node. If `node` is missing or older than 20, Claude tells you so in one line when the session starts, with a link to [nodejs.org](https://nodejs.org). Until then, the hooks step aside and never block a command.

**On Windows**, Claude Code runs hook commands in Git Bash, where all of this works. Without Git Bash it falls back to PowerShell. There, the Node check at session start fails with a one-time, non-blocking hook error, and the push guard doesn't run, because it's attached to the Bash tool. Install [Git for Windows](https://gitforwindows.org) to get both.

## Using it

Just build things. Claude decides what deserves an explanation. You can steer it in plain words, in any language:

| Say | What happens |
|---|---|
| "explain more", "why?", "اشرح أكتر" | Goes one level deeper on that topic |
| "I know this", "skip", "عارف" | Explains less, and remembers that for the topic |
| "just build", "كمّل ساكت" | Stops explaining until you ask again. Risks are still flagged in one line |
| "check me", "اختبرني" | Runs an ownership check on your current change |

Claude remembers what you already know across projects, so it doesn't explain the same thing twice. This memory lives in `~/.comprende/` on your machine and is never committed.

It's on in every session, not only when your request sounds like you want to learn. At session start, one fixed line reminds Claude to follow the skill whenever it writes or changes code. "add a login endpoint" gets the same treatment as "teach me while you build". To turn that line off, set `COMPRENDE_QUIET=1` in your environment. The skill still loads when you ask for explanations, and the ownership gate isn't affected.

## For teams: the ownership gate

### Turn it on

Open Claude in the repo and say:

> Enable the ownership gate in this repo.

Claude asks who should own the gate's settings (usually the lead), opens a PR that adds the gate, and once it's merged, offers to create the GitHub rule that makes the check required. To do the same by hand:

```bash
node <plugin>/dist/gate.mjs install --repo . --owner @your-org/leads
# commit, open a PR, merge it, then:
node .learning/gate.mjs protect            # dry run: shows the GitHub ruleset it would create
node .learning/gate.mjs protect --apply    # needs admin; adds to existing branch protection, never replaces it
```

Teammates with the plugin don't need to do anything else: the first time they open Claude in the repo, their local hook is installed. Teammates without it run `node .learning/gate.mjs install-hooks` once per clone.

### What the developer experiences

- **While building:** after each meaningful piece, Claude asks one or two quick questions, only when that piece had something worth asking. Saying "later" defers them.
- **Before the PR, always:** a short final check of 3 to 6 questions, sized to the change's size and risk, not to the person's seniority. The questions cover:
  - how the parts fit together
  - one or two earlier concepts, asked in a new form
  - every sensitive file
  - a PR summary in the developer's own words

  A wrong answer gets a short explanation and a *different* follow-up question, never the same one again.
- **Small changes, quickly:** a typo fix or a one-line tweak gets **one** question and needs only a 30-character summary. That applies when it adds and removes at most 10 lines (lockfiles and other ignored files not counted), and touches nothing sensitive, binary or a submodule. The report is still saved and still fingerprints every file.
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
  "small_change_lines": 10,
  "small_summary_chars": 30,
  "skip_label": "skip-ownership-check"
}}
```

- **`mode`:** `required` blocks the merge; `suggested` only warns; `off` turns the gate off.
- **`sensitive`:** these files must be explicitly verified. Submodule bumps always count as sensitive.
- **`ignore`:** these files never need questions, but they're still tracked.
- **`small_change_lines`, `small_summary_chars`:** the fast path for small changes. If the added + removed lines across non-ignored files are at most `small_change_lines`, the summary only needs `small_summary_chars`. Nothing sensitive, binary or a submodule can be in the change. `0` turns it off. The fast path only applies once the base branch runs a gate that knows it, so local checks and CI always agree.
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
- **One file.** The whole gate is `gate.mjs`, one bundled file that imports only Node's built-ins (`node:fs`, `node:crypto` and so on). It's copied into each repo, and CI runs the copy on the base branch.
- **Safe in repos you don't trust.** The plugin only ever runs its own copy and never executes code from the repo it's looking at, whose config it reads as data. It installs the local git hook automatically only when the repo's `gate.mjs` is byte-identical to the plugin's. Because it imports only `node:` built-ins, no file in a repo can stand in for a module it loads.

## Limits, honestly

- **A determined developer can write a report by hand.** The report is a file in their own repo, and nothing outside it can vouch for it. The gate makes skipping deliberate and permanent in git history under their name; it can't make skipping impossible. Treat it as a process tool, not a security boundary. A reviewer reading the summary is part of the system.
- **Local hooks can be bypassed** with `--no-verify`. CI plus the ruleset can't.
- **Code-owner review** means the lead can't approve their own PRs that change the gate. On one-person repos, use `protect --no-code-owners`.
- **Rulesets aren't available for private repos on GitHub's free plan.** Use classic branch protection there.
- **GitHub only for now.** CI tests it on Linux and macOS with Node 20, 22 and 24. Windows should work with Node and Git for Windows (Git Bash), but it isn't tested yet.

## Repository layout

```
.claude-plugin/       plugin + marketplace manifests, icon
skills/comprende/
  SKILL.md            when and how Claude explains
  references/         signals, formats, examples, memory, the ownership-check protocol
  scripts/            gate.mjs and learning.mjs (copies of the built files, for the skill on its own)
hooks/hooks.json      SessionStart (auto-setup) and PreToolUse (block unverified pushes)
.mcp.json             the memory server
src/                  TypeScript source: gate.ts, store.ts, server.ts, learning.ts
dist/                 the built, dependency-free files the plugin runs (committed)
test/                 node:test suite against real git repos
docs/demo.tape        VHS script for the terminal demo (vhs docs/demo.tape writes docs/demo.gif)
CLAUDE.md             notes for Claude Code when working on this repo (incl. an end-to-end test plan)
```

## Development

```bash
npm ci
npm run check      # type-check, build dist/, run every test against real git repos
claude plugin validate ./.claude-plugin/plugin.json
```

`dist/` is committed, because that's what the plugin runs. CI fails if `dist/` doesn't match a fresh build of `src/`, so always run `npm run build` before committing.

The tests run against real git repos and are grouped by topic, one file each in `test/`:
- `install`, `config`, `checks`, `report`, `small-changes`
- `fingerprints`: which files a change touches, and when a verified file still counts as verified
- `push-detection`, `hooks`, `security`, `ci`
- `store` and `mcp`, for the memory server
- `consistency`: manifests, built copies, docs and the demo agree

They include real pushes through the hooks, a fresh CI-style clone at the PR head, the workflow's actual shell step, and a regression test for every bug found so far.

To try a local copy: `claude plugin marketplace add ./` from the repo root.

**Releasing:** `plugin.json` sets `version`, so people who installed the plugin only get an update when it changes. Bump it (and add a CHANGELOG entry) with every release. Users update with `/plugin marketplace update comprende`, or by turning on auto-update for this marketplace in `/plugin`.

Issues and PRs are welcome. For security-relevant problems, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
