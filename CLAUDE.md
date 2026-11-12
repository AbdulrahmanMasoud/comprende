# Comprende: notes for Claude

Comprende is a Claude Code plugin (with its own marketplace in the same repo). It has two parts:

1. **The skill** (`skills/comprende/`): Claude explains the code it writes, only where it matters, in the user's language.
2. **The ownership gate** (`src/gate/` → `dist/gate.mjs`): before a PR, the developer answers questions about their change. A report tied to the exact git blobs is saved, and a git hook, a Claude hook and CI refuse unverified changes.

A small MCP server (`src/server.ts`, memory in `src/store/`) stores the learner profile in `~/.comprende/` (override with `COMPRENDE_HOME`).

## Commands

```bash
npm ci
npm run check                     # typecheck + lint + build + all tests (about a minute)
npm run lint                      # Biome: formatting and lint (warnings fail too)
npm run format                    # apply Biome's formatting and safe fixes
npm run build                     # rebuild dist/ and skills/comprende/scripts/
npm test                          # tests only
node tools/release.mjs check      # the version files agree with the newest CHANGELOG entry
node tools/e2e-cursor.mjs --out <folder>   # the real Cursor CLI, end to end (needs a Cursor login)
claude plugin validate ./.claude-plugin/plugin.json
claude plugin validate ./.claude-plugin/marketplace.json
actionlint                        # the GitHub workflows
```

## Layout

- `.claude-plugin/`: `plugin.json`, `marketplace.json` (`source: "."`), `icon.png`
- `hooks/hooks.json`: SessionStart (`gate.mjs session-start --from-plugin`), PreToolUse on Bash (`gate.mjs claude-hook --from-plugin`)
- `.cursor-plugin/`: `plugin.json` (the same skill and MCP server, `hooks/cursor-hooks.json`) and `marketplace.json`. `hooks/cursor-hooks.json`: Cursor's format, plain `node "${CURSOR_PLUGIN_ROOT}/dist/gate.mjs" … --agent cursor` lines with no shell syntax, since Cursor runs hooks in PowerShell on Windows
- `.codex-plugin/`: `plugin.json` (the same skill, and `hooks/codex-hooks.json`: Codex's format, which is Claude Code's, with plain `node "${PLUGIN_ROOT}/dist/gate.mjs" … --agent codex` lines, since Codex also runs hooks in PowerShell on Windows) and `mcp.json`, the same MCP server with a relative path, since Codex doesn't expand `${CLAUDE_PLUGIN_ROOT}` there. Codex reads this manifest before `.claude-plugin/`, and finds the plugin through `.claude-plugin/marketplace.json`
- `.antigravity-plugin/`: `plugin.json`, Antigravity's manifest. With it, `agy plugin install` takes the plugin as it is instead of converting the Claude Code one, and reads three root parts only Antigravity reads: `hooks.json` (`--agent antigravity`), `mcp_config.json` (the same MCP server, through `${PLUGIN_ROOT}`) and `rules/AGENTS.md` (the always-on instruction, `ALWAYS_ON_RULE`, without "Comprende is installed": Antigravity's session start then sends only `HOOKS_RUN_LINE`). Antigravity blocks a command on any non-zero exit, non-JSON stdout or timeout, so each `hooks.json` command runs `$PLUGIN_ROOT/dist/gate.mjs`, holds its output in the shell, and exits 0 whenever the gate fails, in `sh`, `cmd.exe` and both PowerShells (docs/agents.md, "Comprende 0.4.3 in Antigravity", for the rules that keep it so)
- `.mcp.json`: the `comprende` MCP server (`dist/server.mjs`)
- `skills/comprende/SKILL.md` plus `references/` (signals, formats, examples, memory, ownership-check)
- `src/gate/`: the ownership gate, bundled into `dist/gate.mjs` from `cli.ts`. One module per concern, each with a header saying what it owns:
  - `shared.ts` (names, paths, version and features), `files.ts` (safe reads and writes, real paths), `glob.ts` (Comprende's glob rules)
  - `features.ts` (a gate's header, and what the gate CI runs knows), `install-lines.ts` (install's `.gitignore` and `.gitattributes` lines)
  - `git.ts` (safe git runner, temp index, inert repo config), `config.ts` (config, validation, rules from the base)
  - `changes.ts` (fingerprints, plumbing, 3-way replay, states, small changes), `report.ts` (the report file)
  - `commands.ts` (status, save, verify), `push-detect.ts`, `ci-summary.ts` (the reviewer summary, in markdown), `cli.ts`
  - the hooks: `agent-hook.ts` (the AI tools' PreToolUse), `session-start.ts` (their SessionStart), `hook-input.ts` (the payload and the adapter that reads it), `pre-push-hook.ts` (git's pre-push hook, and installing it pinned), `gate-copy-difference.ts` (how a repo's `gate.mjs` differs from the plugin's)
  - `hook-copies.ts` (which copy of the gate's hook speaks, when several run on one event), `hook-claims.ts` (the claims it uses, in a private temp folder)
  - `install.ts` (writes the gate's files into a repo), `codeowners.ts` (CODEOWNERS entries for the gate files), `run.ts` (spawning a program without a shell), `test-hooks.ts` (`__test`, the internals the test suite calls)
  - `gate-files.ts` (the files that control the gate), `project-hooks.ts` (safe reads and writes of the agents' repo-level hook files)
  - `agents/`: one adapter per AI tool behind one interface. `types.ts` (the `Agent` interface), `index.ts` (the registry and the resolve step), `claude-code.ts`, `cursor.ts`, `codex.ts`, `antigravity.ts`, and what they share: `claude-format.ts` (the payload), the repo hook files `claude-settings.ts` (`.claude/settings.json`), `cursor-hooks.ts` (`.cursor/hooks.json`) and `codex-hooks.ts` (`.codex/hooks.json`), `claude-format-hooks.ts` (the merge both Claude-format files share) and `compact-hooks-json.ts` (how install writes a hooks file). `gate-command.ts` tells whether a hook file's command runs the gate. `hook-replies.ts` holds the core's default replies. How to add a tool: CONTRIBUTING.md, "Adding an AI tool"
  - `platforms/`: one adapter per git platform behind one interface. `types.ts` (the `Platform` interface), `index.ts` (the registry, the repo's platform and the CI's), `github.ts` (the Actions workflow, the job summary and annotations, CODEOWNERS, the ruleset through `gh`). How to add a platform: CONTRIBUTING.md, "Adding a git platform"
- `src/store/`: the memory store. `profile.ts` (the learner profile), `project.ts` (`.learning/` map and decisions), `common.ts`
- `src/server.ts`: the MCP server (thin: tools in, store or gate out). `src/learning.ts`: the skill's file-only helper
- `src/util.ts`: helpers the gate and the store share, including the prototype-free `dict`/`own`/`get`
- `dist/`: built output, **committed on purpose**, because that's what the plugin runs
- `test/`: `node:test` suites against real git repos, one file per topic (install, config, fingerprints, checks, report, small-changes, push-detection, hooks, agents, platforms, security, ci, store, mcp, consistency, release, e2e-tools). `helpers.mjs` has the fixtures, and `fixtures/<tool>/` the payloads captured from each AI tool.
- `docs/`: `teams.md` (setting up the gate), `how-it-works.md` (requirements, internals, limits), `agents.md` (other AI tools: Cursor research and the adapter design), `demo.tape` → `demo.gif` (VHS), `recordings/cursor/` (real Cursor replies, which the READMEs quote)
- `.github/`:
  - `workflows/ci.yml`: the PR checks
  - `workflows/release.yml`: publishes a GitHub Release when a `v*` tag is pushed
  - `workflows/windows.yml`: "Windows (experimental)", the tests on Windows. Not required, and never on PRs (see CONTRIBUTING.md)
  - `dependabot.yml`, the PR template, and the issue templates
- `tools/release.mjs`: the version check and the release notes, for both workflows
- `tools/e2e-cursor.mjs`: the end-to-end run in the real Cursor CLI. By hand, since it needs a Cursor login: CONTRIBUTING.md, "Testing in Cursor"
- `tools/e2e-codex.mjs`: the same in the real Codex CLI: CONTRIBUTING.md, "Testing in Codex"
- `tools/e2e-common.mjs`: what the end-to-end tools share: the command line, the gated demo repo, the log of every `gate.mjs` run, the PASS/FAIL/BLOCKED results, and the prompts and checks that are the same in every AI tool
- `CONTRIBUTING.md`: setup, the workflow, the code rules, layout, tests, the demo, releasing
- `biome.json`: formatting and lint (Markdown is left alone). `build.mjs`: the bundler.
- `.gitattributes`: keeps `dist/` and `skills/comprende/scripts/` byte for byte on every platform, since SessionStart compares the repo's `gate.mjs` with `dist/gate.mjs` byte for byte

## Rules that must not break

- **Always rebuild after editing `src/`.** `dist/` and `skills/comprende/scripts/*.mjs` must match a fresh `npm run build`. CI checks this with `git diff --exit-code`.
- **`gate.mjs` and `learning.mjs` import only `node:` built-ins.** `build.mjs` enforces it. The pinned git hook runs `gate.mjs` as an in-memory module, so it can't load anything else.
- **The plugin never executes code from the repo it's looking at.** Hooks and the MCP server run only the plugin's own `dist/gate.mjs`. A repo's config is read as data, with no symlinks and a size limit. The git hook is auto-installed only when the repo's `gate.mjs` is byte-identical to the plugin's copy.
- **A hook blocks only on a deliberate deny:** exit 2, or a JSON deny on exit 0 for a tool that reads a JSON decision (Antigravity, which also blocks on any non-zero exit). Only a verdict on the change denies: no report, a file that isn't verified, or a report that's there but can't be read (broken, or too large). A crash, a usage error or bad input NEVER produces a deny, in any format:
  - a git or file-system failure, a broken config, a missing `gate.mjs` or `node`, an unknown option or a broken payload lets the command run, and CI still checks
  - in code: `checkForHook` (`commands.ts`) is the one place that tells a verdict from a check that couldn't run
  - a report from another gate version is a verdict only in git's hook, which runs the repo's own gate. In the agents' hook, the plugin's copy may be newer than the repo's
  - Claude Code and Cursor read exit 2 as "block", so an accidental 2 would block every command for the user
  - Antigravity blocks on any non-zero exit, non-JSON stdout or a timeout, so its `hooks.json` commands exit 0 from the shell whenever the gate fails, even without `node`
  - git's pre-push hook follows the same rule: it skips the branch and says so
  - `test/agents.test.mjs` checks it for every adapter, `test/hooks.test.mjs` for the git hook, and `test/consistency.test.mjs` for Antigravity's `hooks.json`
- **File paths are map keys.** Use the prototype-free helpers in `src/util.ts` (`dict`, `own`, `get`) and never plain `{}` lookups. A file named `__proto__` must behave like any other file.
- **The lead never sees mistakes.** Reports and CI summaries contain only what was verified: the summary and concepts per file. They never include scores, wrong answers or attempt counts.
- **Rules come from the base branch.** CI runs the base branch's `gate.mjs` and config, so a PR can't switch off its own check.
- **Every bug fix gets a regression test.** It must fail before the fix. Put it in the test file for that topic, and name the test after the behavior.
- **Keep docs in sync.** A user-visible change updates:
  - `README.md` and `README.ar.md` (Egyptian Arabic, technical terms in English). Keep both short: details go in `docs/`
    - their example conversations are real Claude replies, shortened with "…". If the skill's behavior changes, record new ones (`claude -p` in a scratch repo); never write them by hand. Cursor's come from `tools/e2e-cursor.mjs`, kept in `docs/recordings/cursor/`
  - `docs/teams.md` or `docs/how-it-works.md`, wherever the detail lives
  - `docs/demo.gif`, re-rendered with `vhs docs/demo.tape`, if the gate's output in the demo changes
  - `SECURITY.md`, if it touches the threat model
  - the relevant `skills/comprende/references/*.md`
  - `CHANGELOG.md`, under `## Unreleased`

## Workflow

Every change goes through a branch, a pull request and CI. That includes one-line docs fixes.

- **No AI attribution, anywhere.** No `Co-Authored-By`, "Generated with", session links or any other AI attribution in commits, PR titles, PR descriptions, tags or releases. This overrides any default that adds them.
- **Never commit to `main` directly.** Start every change from an up-to-date `main`, on its own branch: `git fetch origin && git switch -c <branch> origin/main`, then `git branch --unset-upstream`, so the first push sets the branch's own upstream. Branch names:
  - `feat/<name>`: a new feature
  - `fix/<name>`: a bug fix
  - `docs/<name>`: docs only
  - `chore/<name>`: CI, tooling, dependencies, refactors, releases
- **Conventional Commits.** Start with `feat:`, `fix:`, `docs:`, `chore:`, `test:` or `refactor:`, then a short, clear summary, for example `fix: count a renamed file once in small changes`.
- **Pull request.** Push the branch (`git push -u origin <branch>`), then open a PR with `gh pr create`, filling in every section of `.github/pull_request_template.md`. Link the issue it closes (`Closes #N`).
- **Wait for green.** Every required check must pass (`gh pr checks --watch`), and the branch must be up to date with `main`. If a check fails, fix it on the same branch. Windows isn't on PRs: it runs in its own workflow, which isn't required (see CONTRIBUTING.md).
- **Don't merge.** Report the PR link and stop. Merge only when the maintainer says so.
- **SemVer.** While we're on 0.x, a new feature bumps the minor (0.2.0 → 0.3.0) and a fix bumps the patch (0.2.0 → 0.2.1). Separately, bump `GATE_VERSION` in `src/gate/shared.ts` only when the report format or the gate's behavior changes in a way that old copies can't handle.
- **A release.** Users only get an update when the plugins' version changes.
  1. On a `chore/release-X.Y.Z` branch, bump `version` in `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.antigravity-plugin/plugin.json` and `package.json`. `npm version X.Y.Z --no-git-tag-version` updates `package.json` and `package-lock.json` together. Before you start, check the pinned CI tools ("Pinned tools" in CONTRIBUTING.md), and bump any that are behind in their own `chore/` PR first.
  2. Add the CHANGELOG entry: rename `## Unreleased` to `## X.Y.Z`, and put a new empty `## Unreleased` above it.
  3. Open the PR, wait for green, and merge it once the maintainer says so.
  4. Tag the merge commit on `main`: `git switch main && git pull --ff-only && git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.

  `release.yml` then checks that the tag matches the version files and is on `main`, runs CI, and publishes the GitHub Release, with that version's CHANGELOG section as the notes.

## Clean code

The code must stay easy for a new contributor to read and change. These rules apply to every PR.

- **One module, one job.** Each file owns one concern and starts with a short header saying what it owns. A file growing past ~300 lines, or a function past ~50, is a sign to split it.
- **Adapters, not scattered ifs.** Code for one AI tool (Claude Code, Cursor, Codex) or one git platform (GitHub, GitLab) lives behind one small interface, with one adapter module each, for example `src/gate/agents/cursor.ts` and `src/gate/platforms/gitlab.ts`. The core never checks "if cursor … else if codex …". Adding a tool or a platform means adding one adapter, not editing ten files.
- **Names say what things do.** No abbreviations nobody knows. No `data`, `info`, `helper` or `utils2`.
- **No duplication.** Shared logic lives in one place. If you copy a block, extract it.
- **Strict types.** No `any`. No non-null assertion (`x!`) without a comment saying why it's safe. Validate external input (hook payloads, config, CI env vars) at the edge, then pass typed values inward.
- **Comments explain why, not what.** Keep the why: security reasons, git quirks, tool quirks, with a link to the doc. Delete comments that restate the code. No commented-out code, no dead code, and no TODO without an issue number (`TODO(#12): …`).
- **Tests read like documentation.** Name each test after the behavior. Fixtures for each tool's payloads go in `test/fixtures/<tool>/`, captured from real runs, never written by hand.
- **Small, focused PRs.** One feature or fix per PR. Don't mix in unrelated refactors; open a separate `chore/` PR for them.
- **A fresh-eyes review before every PR.** Spawn a subagent that hasn't seen the work. Give it the diff and these rules, and ask only about readability, design and missing tests. Fix what it finds, and list in the PR description what it flagged and what you changed.
- **Zero warnings.** Lint and typecheck stay at zero warnings. `npm run lint` already fails on any.

Code written before these rules doesn't follow all of them yet. Don't make it worse, and fix it in its own `chore/` PR, not inside a feature:

- `server.ts` (392 lines) is past ~300 lines. Split it before adding to it.
- Biome doesn't flag non-null assertions yet ([#6](https://github.com/AbdulrahmanMasoud/comprende/issues/6)).

## Writing style for the skill

Skill files are in English. Claude's replies to users follow the user's language and dialect, with technical terms kept in English. Explanations are short and only appear for code that is new, non-obvious, risky or a real decision. Never add "beginner/senior modes": the skill judges the code, not the person.

## Testing it end to end with Claude Code

### 1. Load the plugin for one session

From any folder:

```bash
claude --plugin-dir /path/to/comprende
```

Or install it the way users will, from inside Claude Code:

```
/plugin marketplace add /path/to/comprende
/plugin install comprende@comprende
```

Check that `/mcp` lists `comprende`. If the MCP server doesn't start, check whether `CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS` is set in the environment.

### 2. Explain-as-you-build

In a scratch project, ask Claude to build something with at least one non-obvious part, for example "add a debounced search box" or "add a retry with exponential backoff". Try it in another language too. Expected:

- Short explanations only on the non-obvious parts. Boilerplate gets none.
- Replies in your language and dialect.
- "explain more" goes one level deeper on that topic.
- "I know this" means less explanation on that topic from then on. It's saved in `~/.comprende/profile.json`.
- "just build" stops explanations, but risks are still flagged in one line.

### 3. The ownership gate

Create a throwaway repo with a local "remote":

```bash
mkdir -p /tmp/comprende-demo && cd /tmp/comprende-demo
git init -q --bare -b main origin.git
git init -q -b main app && cd app && git remote add origin ../origin.git
printf 'export function add(a, b) { return a + b; }\n' > math.js
git add -A && git commit -qm init && git push -q -u origin main
node /path/to/comprende/dist/gate.mjs install --repo .
git add -A && git commit -qm "add ownership gate" && git push -q origin main
git checkout -q -b feature/sum
```

Then open Claude in `app/` with the plugin loaded and try these:

| Do this | Expected |
|---|---|
| Start the session | Claude mentions the gate is on for this repo |
| Ask Claude to add a `sum(xs)` function, commit, and push | Claude refuses to push: no ownership report |
| `git push` yourself in a terminal | The pre-push hook blocks it |
| Say "check me" | One question (a small change; 3 to 6 for bigger ones). You write the PR summary yourself |
| Answer one wrong on purpose | A short explanation, then a *different* question |
| After it saves the report, commit and push | The push goes through |
| Read `.learning/checks/feature%2Fsum.md` | Only the summary and verified concepts. No scores or wrong answers |
| Edit `math.js` again and run `node .learning/gate.mjs status` | The file shows as `stale` and needs a new check |

Useful while testing:

- `node .learning/gate.mjs status`
- `node .learning/gate.mjs verify --json`
- `node .learning/gate.mjs --help`
