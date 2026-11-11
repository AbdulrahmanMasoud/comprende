# Contributing

## Contributions

Comprende isn't accepting pull requests from outside contributors right now. Bug reports, feature requests and feedback are very welcome: [open an issue](https://github.com/AbdulrahmanMasoud/comprende/issues/new/choose). For a security problem, see [SECURITY.md](SECURITY.md). This may change later.

The rest of this file is the maintainers' guide. The rules that must not break, and the full workflow and code rules, are in [CLAUDE.md](CLAUDE.md).

## Setup

```bash
npm ci
npm run check      # type-check, lint, build dist/, run every test against real git repos
npm run format     # apply Biome's formatting and safe lint fixes
claude plugin validate ./.claude-plugin/plugin.json
```

`dist/` is committed, because that's what the plugin runs. CI fails if `dist/` doesn't match a fresh build of `src/`, so run `npm run build` before committing.

To try your local copy: `claude --plugin-dir .`, or `claude plugin marketplace add ./` from the repo root. In Cursor's CLI: `cursor-agent --plugin-dir .`.

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

Cursor's agent adds a `Co-authored-by: Cursor <cursoragent@cursor.com>` trailer to the commits it makes. If you work in Cursor, turn off `attribution.attributeCommitsToAgent`, or remove the line before you push.

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

Code that's specific to one AI tool (Claude Code, Cursor, and later Codex and Antigravity) lives in one adapter module, behind a small interface that every adapter implements. The same goes for git platforms (GitHub, and later GitLab).

```
src/gate/agents/      types.ts (the Agent interface), index.ts (the registry and the resolve step),
                      one module per AI tool: claude-code.ts, cursor.ts, plus what they share:
                      claude-format.ts (the payload), the repo hook files claude-settings.ts and
                      cursor-hooks.ts, and gate-command.ts (does a hook file's command run the gate)
src/gate/hook-replies.ts   the core's default replies, for adapters that don't format their own
src/gate/hook-copies.ts    which copy of the gate's hook speaks when several run on one event,
                           with the claims in hook-claims.ts
src/gate/platforms/   types.ts (the Platform interface), index.ts (the registry, the repo's platform
                      and the CI's), one module per git platform: github.ts
```

The core (`status`, `save`, `verify`, push detection, the hooks) gets typed values from an adapter. It never asks which tool or platform it runs under. So:

- there's no `if (tool === "cursor") … else if (tool === "codex") …` outside the adapters
- adding a tool or a platform means adding one module, its tests and its fixtures, not editing ten files
- each adapter validates its raw input (a hook payload, CI env vars) before anything else sees it

Payload fixtures for each tool go in `test/fixtures/<tool>/`, captured from real runs, never written by hand.

#### Adding an AI tool

The interface, with a comment on each member, is in `src/gate/agents/types.ts`. [docs/agents.md](docs/agents.md#the-agent-adapter-interface) shows how each tool fills it in.

1. **Capture real payloads.** Register hooks in the tool that only record their stdin and environment, in a throwaway repo with a local bare remote. Capture its session start, and its pre-tool hook for a push, for `ls`, and for a tool that isn't the shell. Remove personal data: paths with a username, emails, tokens and session IDs. Save one file per case in `test/fixtures/<tool>/`, with a README saying how they were captured. [`test/fixtures/cursor/`](test/fixtures/cursor/) is an example.
2. **Write `src/gate/agents/<tool>.ts`:**
   - `id`: add it to `AgentId` in `types.ts`.
   - `detects`: only if the tool runs another tool's hook command, the way Cursor runs Claude Code's. Detect from a field only that tool sends. Prefer `--agent <id>` in the tool's own hook files.
   - `shellCommand`: the command, only for the tool's shell tool.
   - `projectDir`: the repo, from the payload or the tool's project variable. Return null when the run can't tell, and the hook steps aside. Never guess from the process's folder unless the tool always runs hooks from the project.
   - `names` and `pluginUpdateHint`: how messages name the tool, and how its users update the plugin. The core's own text never names a tool.
   - `projectHookFiles`: the repo-level files that register the gate's hook, most specific first. Mark a file `alwaysRuns: false` when the tool runs it only while a setting is on: no other copy steps aside for it.
   - `eventId`: the id the tool gives a tool call or a session, the same for every hook on it. Copies of the gate that can't step aside for each other claim it, so only one speaks. Return null when one session can't run two copies.
   - `formatDecision` and `formatSessionContext`: only if the tool doesn't accept the defaults (exit 0 or exit 2 with stderr, and `hookSpecificOutput.additionalContext`).
3. **Register it in `src/gate/agents/index.ts`.** In `AGENTS`, a tool that runs another tool's hook commands goes before that tool. `PROJECT_HOOK_FILES`, and from it `GATE_FILES`, pick up its files.
4. **Hook commands for its plugin or settings file.** Run `node <gate.mjs> agent-hook --agent <id>` and `session-start --agent <id>`, with `--from-plugin` in the plugin's file, and `session-start --from-repo` in the repo's. Use no shell syntax, so they run in PowerShell too. Make sure a missing `node` fails open: any exit code but 2.
5. **Tests from the fixtures,** in `test/agents.test.mjs`:
   - its payloads resolve to it
   - it reads the command and the repo
   - an unverified push is blocked
   - `ls` and other tools pass silently
   - the step-aside rules
6. **Check it end to end** in the tool itself, with a gated demo repo: an unverified push is blocked, a verified one goes through, and the session-start message arrives.
7. **Docs:** `docs/agents.md`, the install steps in both READMEs, and `SECURITY.md` if it adds a gate file.

#### Adding a git platform

The interface is in `src/gate/platforms/types.ts`, with a comment on each member. GitHub's adapter, `github.ts`, holds everything GitHub-specific:

```ts
export interface Platform {
  readonly id: PlatformId;
  detects(env: CiEnv): boolean;                    // is this the platform's CI?
  readonly ciConfig: {                             // the CI config install writes
    readonly path: string;
    withGateJob(existing: ExistingFile): { readonly content?: string; readonly message: string };
  };
  readonly checkName: string;                      // the status protect makes required
  ciContext(env: CiEnv): CiContext;                // { baseRef, headBranch, labels }, null = CI doesn't say
  reviewerSummaryFile(env: CiEnv): string | null;  // where the markdown summary goes
  annotations(kind: AnnotationKind, messages: readonly string[], env: CiEnv): string;  // stdout, "" for none
  readonly codeowners: { readonly paths: readonly string[]; readonly ownerPattern: RegExp; readonly ownerHint: string; readonly reviewSetting: string };
  readonly cli: { readonly program: string; readonly optionsWithValue: ReadonlySet<string>; readonly pullRequestCommands: readonly (readonly [string, string])[] };
  protect(root: string, options: ProtectOptions): string[];  // dry run unless options.apply
}
```

The CI methods may be called outside the platform's CI, because `ciPlatform` falls back to the repo's platform. Each one reads only its own CI's variables, and returns null or `""` when they aren't set.

1. **Capture a real CI run.** Record the environment a merge-request job gets, and save it, cleaned of tokens and names, in `test/fixtures/<platform>/`.
2. **Write `src/gate/platforms/<platform>.ts`.** Check each method against what the platform really does. For GitLab, from its docs:
   - **`ciConfig`:** a merge-request job's `rules:` must be in `.gitlab-ci.yml` itself, not an `include:`. So `withGateJob` merges a job into that file, and keeps the rest. That makes `.gitlab-ci.yml` a gate file, though, so every CI edit would skip the check and need the lead's review. Decide that before building it.
   - **The base branch's gate:** a merge request can edit its own pipeline. Running the base branch's gate is only binding with the CI config in another project (`ci_config_path`) or a pipeline execution policy (Ultimate). `install` and `protect` must say so.
   - **`ciContext`:**
     - The base comes from `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, returned as `origin/<name>`, which is what `--base` takes. The job has to fetch it, because the clone is shallow.
     - The head branch comes from `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`.
     - The labels come from the comma-separated `CI_MERGE_REQUEST_LABELS`, which is missing when there are none. A label change doesn't start a pipeline, so adding the skip label needs a manual rerun.
   - **`reviewerSummaryFile`:** a file the job exposes with `artifacts:expose_as`, with `when: always`, or a failed check loses its summary. There's no inline job summary. Markdown isn't previewed, so reviewers download it.
   - **`annotations`:** none (`""`). Code Quality reports are the closest thing.
   - **`codeowners`:** `paths` in GitLab's search order: `CODEOWNERS`, `docs/CODEOWNERS`, `.gitlab/CODEOWNERS`. Code-owner approval is Premium. On Free, nothing stops a merge request from editing the gate's files, which is one more reason for `ci_config_path` above.
   - **`cli`:** `glab`, with `mr create` and `mr merge`.
   - **`protect`:** "Pipelines must succeed" (`only_allow_merge_if_pipeline_succeeds`, through `glab api`) is free but covers the whole pipeline. There's no required check for a single job; Ultimate's external status checks are a different thing. Approval counts and code-owner approval are Premium. Say which parts were applied and which need a higher tier.
3. **Register it in `src/gate/platforms/index.ts`.**
   - With two platforms, the repo's config has to name its platform.
   - `REPO_PLATFORM` and `GATE_FILES` are module constants today, and become functions of the repo's config.
   - The base branch's gate still has to agree with the local one about which files are gate files, the way features do (`features.ts`).
4. **Tests** in `test/platforms.test.mjs` and `test/ci.test.mjs`, from the captured environment.
5. **Check it end to end** on a real merge request: an unverified change fails the pipeline, the skip label passes, a verified one passes, and the summary is there for reviewers.
6. **Docs:** `docs/teams.md`, and both READMEs.

The end of "Clean code" in [CLAUDE.md](CLAUDE.md) lists where today's code doesn't follow the rules yet.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every PR and on `main`:

| Job | What it checks |
| --- | --- |
| `Lint, typecheck and build` | `npm run typecheck`, `npm run lint`, and that `dist/` matches a fresh build |
| `Tests (ubuntu-latest, Node 20)` … `Tests (macos-latest, Node 24)` | `npm test` on Ubuntu and macOS, Node 20, 22 and 24 |
| `Consistency` | the versions agree (`node tools/release.mjs check`, including `.cursor-plugin/plugin.json`), `claude plugin validate` on both Claude Code manifests, `actionlint` on the workflows. Cursor has no validator, so the tests in `consistency.test.mjs` check its manifests |

Branch protection requires every one of these jobs, by name. If you rename one, update the ruleset in the repo settings in the same PR.

### Windows

Windows isn't supported yet. A separate workflow, "Windows (experimental)" ([`.github/workflows/windows.yml`](.github/workflows/windows.yml)), runs `npm test` on `windows-latest` with Node 22, in Git Bash. It runs:

- on every push to `main`
- every Monday at 06:00 UTC
- by hand: `gh workflow run windows.yml`, or "Run workflow" on the Actions tab

It never runs on PRs and isn't required, so a failure there blocks nothing. Until Windows is supported, expect it to fail, and so to show a red X on `main`'s commits. [#10](https://github.com/AbdulrahmanMasoud/comprende/issues/10) lists what fails and why.

### Dependabot

Dependabot opens one grouped PR a week for GitHub Actions, and one for npm devDependencies. It skips major updates of `@types/node`, which must stay on the oldest Node in `engines.node`. `test/consistency.test.mjs` checks that, and it runs with `npm test`.

The MCP SDK and zod are bundled into `dist/server.mjs`, so a PR that bumps them, or esbuild, usually fails `dist/ matches the source`. To fix it:

1. Check out its branch: `gh pr checkout <N>`.
2. Run `npm ci && npm run build`.
3. Commit (`chore: rebuild dist for dependency updates`) and push.
4. If `main` has moved since, update the branch from the PR page ("Update branch"), or with `gh pr update-branch <N>`.

Never comment `@dependabot rebase` or `@dependabot recreate` on that PR. Dependabot rewrites its branch with only its own commit, which drops your rebuild commit.

### Overrides

`package.json` overrides `body-parser` to `^2.4.0`, for [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828). It's an indirect dev dependency (the MCP SDK → `express` → `body-parser`) and is never in `dist/`. Remove the override once `express` requires `^2.4.0` itself.

### Pinned tools

CI pins two tools by exact version, and Dependabot can't update either one:

| Tool | Pinned in `ci.yml` | How to find the newest |
| --- | --- | --- |
| Claude Code, for `claude plugin validate` | `CLAUDE_CODE_VERSION` | `npm view @anthropic-ai/claude-code dist-tags.latest` |
| actionlint | `uses: docker://rhysd/actionlint:<version>` | `gh release view -R rhysd/actionlint --json tagName -q '.tagName \| ltrimstr("v")'` |

Pin Claude Code to npm's `latest` tag, which is what users get by default, not its slower `stable` channel. Check both before every release, and bump them in their own `chore/` PR. The Consistency job then checks that the plugin still validates and the workflows still lint.

## Layout

```
.claude-plugin/       plugin + marketplace manifests, icon
skills/comprende/
  SKILL.md            when and how Claude explains
  references/         signals, formats, examples, memory, the ownership-check protocol
  scripts/            gate.mjs and learning.mjs (copies of the built files, for the skill on its own)
hooks/hooks.json      SessionStart (auto-setup) and PreToolUse (block unverified pushes)
.cursor-plugin/       the Cursor plugin and marketplace manifests (same skill, same MCP server)
hooks/cursor-hooks.json  the Cursor plugin's hooks, in Cursor's format
.mcp.json             the memory server
src/gate/             the ownership gate, one module per concern (bundled into dist/gate.mjs)
src/store/            the memory store: learner profile and project notes
src/server.ts         the MCP server; src/learning.ts, the skill's file-only helper
dist/                 the built, dependency-free files the plugin runs (committed)
test/                 node:test suites against real git repos, one file per topic
tools/release.mjs     the version check and the release notes, for CI and releases
tools/e2e-cursor.mjs  the end-to-end run in the real Cursor CLI (by hand, not in CI)
docs/                 the longer docs, and the terminal demo (demo.tape, demo.gif)
.github/              CI and release workflows, Dependabot, PR and issue templates
.gitattributes        keeps dist/ and the skill's scripts byte for byte (no CRLF on Windows)
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

### Testing in Cursor

`tools/e2e-cursor.mjs` drives the real `cursor-agent` through Comprende, headless. It isn't in CI, because it needs a logged-in Cursor CLI and uses the account's agent requests. Run it after a change to the hooks, the skill or the Cursor plugin:

```bash
cursor-agent login                  # once
node tools/e2e-cursor.mjs --out /tmp/e2e
node tools/e2e-cursor.mjs --out /tmp/e2e-2 --only explain,both-plugins   # some scenarios only
```

- **Scenarios**, each in its own demo repo:
  - `main`: session start, an ordinary command, an unverified push, "check me" through to a push that goes through, and the memory server
  - `no-memory`: "check me" with a plugin copy that has no memory server, so the report is saved with `save --input`
  - `explain`: explain-as-you-build on a small retry function
  - `both-plugins`: the Claude Code plugin imported as well. Each session line comes once, and each push is checked once
- **Output:** one line per step: PASS, FAIL, or BLOCKED when Cursor refuses to run the agent (the account's usage limit, or a model not on its plan). Transcripts, replies, stderr and a log of every `gate.mjs` run are saved to `--out`.
- **Isolation:** a throwaway `HOME` with a copy of your `~/.cursor/cli-config.json`, so none of your plugins or settings load, and a `COMPRENDE_HOME` inside `--out`. On macOS the login is in the keychain, which the throwaway `HOME` links to. Elsewhere, set `CURSOR_API_KEY`. Each demo's remote is a local folder, so nothing is pushed anywhere.
- Delete the `--out` folder afterwards: it holds a copy of your CLI config.

## The demo

`docs/demo.gif` is rendered with [VHS](https://github.com/charmbracelet/vhs) from [`docs/demo.tape`](docs/demo.tape):

```bash
vhs docs/demo.tape
```

The consistency test runs the same commands, so the demo can't drift from what the gate does. Render it again whenever the gate's output changes.

## Releasing

`plugin.json` sets `version`, so people who installed the plugin only get an update when it changes. Users update with `/plugin marketplace update comprende`, or by turning on auto-update for this marketplace in `/plugin`.

1. **Bump the version** on a `chore/release-X.Y.Z` branch, in `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json` and `package.json`. `npm version X.Y.Z --no-git-tag-version` updates `package.json` and `package-lock.json` together. Before you start, check the [pinned CI tools](#pinned-tools), and bump any that are behind in their own `chore/` PR first.
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
