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
claude plugin validate ./.claude-plugin/plugin.json
claude plugin validate ./.claude-plugin/marketplace.json
```

## Layout

- `.claude-plugin/`: `plugin.json`, `marketplace.json` (`source: "."`), `icon.png`
- `hooks/hooks.json`: SessionStart (`gate.mjs session-start`), PreToolUse on Bash (`gate.mjs claude-hook --from-plugin`)
- `.mcp.json`: the `comprende` MCP server (`dist/server.mjs`)
- `skills/comprende/SKILL.md` plus `references/` (signals, formats, examples, memory, ownership-check)
- `src/gate/`: the ownership gate, bundled into `dist/gate.mjs` from `cli.ts`. One module per concern, each with a header saying what it owns:
  - `shared.ts` (names, paths, version and features), `files.ts` (safe reads and writes), `glob.ts` (Comprende's glob rules)
  - `git.ts` (safe git runner, temp index, inert repo config), `config.ts` (config, validation, rules from the base)
  - `changes.ts` (fingerprints, plumbing, 3-way replay, states, small changes), `report.ts` (the report file)
  - `commands.ts` (status, save, verify), `push-detect.ts`, `hooks.ts`, `setup.ts` (install, protect), `ci-summary.ts`, `cli.ts`
- `src/store/`: the memory store. `profile.ts` (the learner profile), `project.ts` (`.learning/` map and decisions), `common.ts`
- `src/server.ts`: the MCP server (thin: tools in, store or gate out). `src/learning.ts`: the skill's file-only helper
- `src/util.ts`: helpers the gate and the store share, including the prototype-free `dict`/`own`/`get`
- `dist/`: built output, **committed on purpose**, because that's what the plugin runs
- `test/`: `node:test` suites against real git repos, one file per topic (install, config, fingerprints, checks, report, small-changes, push-detection, hooks, security, ci, store, mcp, consistency). `helpers.mjs` has the fixtures.
- `biome.json`: formatting and lint (Markdown is left alone). `build.mjs`: the bundler.

## Rules that must not break

- **Always rebuild after editing `src/`.** `dist/` and `skills/comprende/scripts/*.mjs` must match a fresh `npm run build`. CI checks this with `git diff --exit-code`.
- **`gate.mjs` and `learning.mjs` import only `node:` built-ins.** `build.mjs` enforces it. The pinned git hook runs `gate.mjs` as an in-memory module, so it can't load anything else.
- **The plugin never executes code from the repo it's looking at.** Hooks and the MCP server run only the plugin's own `dist/gate.mjs`. A repo's config is read as data, with no symlinks and a size limit. The git hook is auto-installed only when the repo's `gate.mjs` is byte-identical to the plugin's copy.
- **A hook blocks only on a deliberate exit code 2.** Any crash or missing file must exit with something else. Claude Code treats exit 2 as "block", so an accidental 2 would block every Bash command for the user.
- **File paths are map keys.** Use the prototype-free helpers in `src/util.ts` (`dict`, `own`, `get`) and never plain `{}` lookups. A file named `__proto__` must behave like any other file.
- **The lead never sees mistakes.** Reports and CI summaries contain only what was verified: the summary and concepts per file. They never include scores, wrong answers or attempt counts.
- **Rules come from the base branch.** CI runs the base branch's `gate.mjs` and config, so a PR can't switch off its own check.
- **Every bug fix gets a regression test.** It must fail before the fix. Put it in the test file for that topic, and name the test after the behavior.
- **Keep docs in sync.** A user-visible change updates:
  - `README.md` and `README.ar.md` (Egyptian Arabic, technical terms in English)
  - `SECURITY.md`, if it touches the threat model
  - the relevant `skills/comprende/references/*.md`
  - `CHANGELOG.md`

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

## Releasing

1. Bump `version` in `.claude-plugin/plugin.json` and `package.json`, and add a `CHANGELOG.md` entry. Users only get updates when the version changes.
2. Run `npm run check`, commit, and tag `vX.Y.Z`.
3. Bump `GATE_VERSION` in `src/gate.ts` only when the report format or the gate's behavior changes in a way old copies can't handle.
