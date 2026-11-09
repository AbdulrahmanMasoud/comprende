# Contributing

Issues and PRs are welcome. For security-relevant problems, see [SECURITY.md](SECURITY.md). The rules that must not break, and the full workflow and code rules, are in [CLAUDE.md](CLAUDE.md).

## Setup

```bash
npm ci
npm run check      # type-check, lint, build dist/, run every test against real git repos
npm run format     # apply Biome's formatting and safe lint fixes
claude plugin validate ./.claude-plugin/plugin.json
```

`dist/` is committed, because that's what the plugin runs. CI fails if `dist/` doesn't match a fresh build of `src/`, so run `npm run build` before committing.

To try your local copy: `claude --plugin-dir .`, or `claude plugin marketplace add ./` from the repo root.

## Workflow: branch → PR → CI → release

`main` is protected: nobody pushes to it directly, the maintainer included. Every change follows these steps:

1. **Branch from an up-to-date `main`:**

   ```bash
   git fetch origin
   git switch -c fix/renamed-files origin/main
   git branch --unset-upstream
   ```

   Use the prefix that matches the change: `feat/`, `fix/`, `docs/` or `chore/` (CI, tooling, dependencies, refactors, releases).
2. **Commit** in the format below. Run `npm run check` before you push.
3. **Push and open a PR:** `git push -u origin <branch>`, then `gh pr create`. Fill in the template ([`.github/pull_request_template.md`](.github/pull_request_template.md)), and link the issue it closes with `Closes #N`.
4. **Wait for CI.** Every required check must be green, and the branch must be up to date with `main`. If a check fails, push the fix to the same branch.
5. **Merge.** The maintainer merges.
6. **Release**, when it's time: see [Releasing](#releasing).

### Commit messages

[Conventional Commits](https://www.conventionalcommits.org/): a type, a colon, then a short summary of what changed.

```
feat: Cursor adapter for the ownership gate
fix: count a renamed file once in small changes
docs: explain the small-change fast path in teams.md
chore: run actionlint in CI
test: cover a report saved but not committed
refactor: move the GitHub summary behind the platform interface
```

No AI attribution (`Co-Authored-By`, "Generated with", session links) in commits, PRs, tags or releases.

### Versions

[SemVer](https://semver.org/). While we're on 0.x:

- a new feature bumps the minor: 0.2.0 → 0.3.0
- a fix bumps the patch: 0.2.0 → 0.2.1

Changes that aren't released yet go under `## Unreleased` at the top of [CHANGELOG.md](CHANGELOG.md).

`GATE_VERSION` in `src/gate/shared.ts` is separate. Bump it only when the report format or the gate's behavior changes in a way that old copies can't handle.

## Code rules

The rules are under "Clean code" in [CLAUDE.md](CLAUDE.md), and the PR template's checklist repeats them. In short:

- **Small pieces.** Each module owns one job and says so in its header.
- **Clear names,** and no duplicated logic.
- **Strict types,** with external input validated at the edge.
- **Comments say why,** not what.
- **Tests are named after behavior.** Every bug fix comes with a regression test.
- **One change per PR.**

### The fresh-eyes review

Before opening a PR, get a review from someone who hasn't seen the work. That can be another person, or a new AI session that has none of your context: give it the diff and the rules, and ask only about readability, design and missing tests. Fix what it finds. In the PR's "Fresh-eyes review" table, list each finding and what you changed, or why you didn't.

### Adapters

Comprende is adding more AI tools (Cursor, Codex) and git platforms (GitLab). Code that's specific to one of them lives in one adapter module, behind a small interface that every adapter of that kind implements:

```
src/gate/agents/      one module per AI tool: claude-code.ts, cursor.ts, codex.ts
                      reads that tool's hook payload, answers in that tool's format
src/gate/platforms/   one module per git platform: github.ts, gitlab.ts
                      reads its CI environment, writes the reviewer summary, sets up branch protection
```

The core (`status`, `save`, `verify`, push detection) gets typed values from an adapter and never asks which tool or platform it runs under. So:

- there's no `if (tool === "cursor") … else if (tool === "codex") …` outside the adapters
- adding a tool or a platform means adding one module, its tests and its fixtures, not editing ten files
- each adapter validates its raw input (a hook payload, CI env vars) before anything else sees it

Payload fixtures for each tool go in `test/fixtures/<tool>/`, captured from real runs.

The Claude Code and GitHub code was written before this rule and isn't behind these interfaces yet. The end of "Clean code" in [CLAUDE.md](CLAUDE.md) lists where today's code doesn't follow the rules, and the issue for each.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every PR and on `main`:

| Job | What it checks | Required |
| --- | --- | --- |
| `Lint, typecheck and build` | `npm run typecheck`, `npm run lint`, and that `dist/` matches a fresh build | yes |
| `Tests (ubuntu-latest, Node 20)` … `Tests (macos-latest, Node 24)` | `npm test` on Ubuntu and macOS, Node 20, 22 and 24 | yes |
| `Consistency` | the versions agree (`node tools/release.mjs check`), `claude plugin validate` on both manifests, `actionlint` on the workflows | yes |
| `Tests (windows-latest, Node 22, experimental)` | `npm test` in Git Bash. Windows isn't supported yet, so this job can fail without failing the run | no |

Branch protection requires the jobs by name. If you rename one, update the ruleset in the repo settings in the same PR.

Dependabot opens one grouped PR a week for GitHub Actions and one for npm devDependencies. Some devDependencies are bundled into `dist/`, so their PR can fail `dist/ matches the source`. Check out the branch, run `npm run build`, and push the result.

## Layout

```
.claude-plugin/       plugin + marketplace manifests, icon
skills/comprende/
  SKILL.md            when and how Claude explains
  references/         signals, formats, examples, memory, the ownership-check protocol
  scripts/            gate.mjs and learning.mjs (copies of the built files, for the skill on its own)
hooks/hooks.json      SessionStart (auto-setup) and PreToolUse (block unverified pushes)
.mcp.json             the memory server
src/gate/             the ownership gate, one module per concern (bundled into dist/gate.mjs)
src/store/            the memory store: learner profile and project notes
src/server.ts         the MCP server; src/learning.ts, the skill's file-only helper
dist/                 the built, dependency-free files the plugin runs (committed)
test/                 node:test suites against real git repos, one file per topic
tools/release.mjs     the version check and the release notes, for CI and releases
docs/                 the longer docs, and the terminal demo (demo.tape, demo.gif)
.github/              CI and release workflows, Dependabot, PR and issue templates
CLAUDE.md             notes for Claude Code when working on this repo (incl. an end-to-end test plan)
```

## Tests

The tests run against real git repos and are grouped by topic, one file each in `test/`:

- `install`, `config`, `checks`, `report`, `small-changes`
- `fingerprints`: which files a change touches, and when a verified file still counts as verified
- `push-detection`, `hooks`, `security`, `ci`
- `store` and `mcp`, for the memory server
- `consistency`: manifests, built copies, docs and the demo agree
- `release`: the version check and the release notes

They include real pushes through the hooks, a fresh CI-style clone at the PR head, the workflow's actual shell step, and a regression test for every bug found so far.

## The demo

`docs/demo.gif` is rendered with [VHS](https://github.com/charmbracelet/vhs) from [`docs/demo.tape`](docs/demo.tape):

```bash
vhs docs/demo.tape
```

The consistency test runs the same commands, so the demo can't drift from what the gate does. Render it again whenever the gate's output changes.

## Releasing

`plugin.json` sets `version`, so people who installed the plugin only get an update when it changes. Users update with `/plugin marketplace update comprende`, or by turning on auto-update for this marketplace in `/plugin`.

1. **Bump the version** on a `chore/release-X.Y.Z` branch, in `.claude-plugin/plugin.json` and `package.json`. `npm version X.Y.Z --no-git-tag-version` updates `package.json` and `package-lock.json` together.
2. **Add the CHANGELOG entry:** rename `## Unreleased` to `## X.Y.Z`, and put a new empty `## Unreleased` above it.
3. **Open the PR.** The maintainer merges it once CI is green. The Consistency job runs `node tools/release.mjs check`, so a missed version file fails there.
4. **Tag the merge commit on `main`:**

   ```bash
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m vX.Y.Z
   git push origin vX.Y.Z
   ```

[`.github/workflows/release.yml`](.github/workflows/release.yml) then:

- checks that the tag is `v` followed by the version in the files, and that the tagged commit is on `main`
- runs the whole CI workflow on the tag
- creates the GitHub Release, using that version's CHANGELOG section as the notes
