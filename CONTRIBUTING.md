# Contributing

Issues and PRs are welcome. For security-relevant problems, see [SECURITY.md](SECURITY.md). The rules that must not break are in [CLAUDE.md](CLAUDE.md).

## Setup

```bash
npm ci
npm run check      # type-check, lint, build dist/, run every test against real git repos
npm run format     # apply Biome's formatting and safe lint fixes
claude plugin validate ./.claude-plugin/plugin.json
```

`dist/` is committed, because that's what the plugin runs. CI fails if `dist/` doesn't match a fresh build of `src/`, so run `npm run build` before committing.

To try your local copy: `claude --plugin-dir .`, or `claude plugin marketplace add ./` from the repo root.

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
docs/                 the longer docs, and the terminal demo (demo.tape, demo.gif)
CLAUDE.md             notes for Claude Code when working on this repo (incl. an end-to-end test plan)
```

## Tests

The tests run against real git repos and are grouped by topic, one file each in `test/`:

- `install`, `config`, `checks`, `report`, `small-changes`
- `fingerprints`: which files a change touches, and when a verified file still counts as verified
- `push-detection`, `hooks`, `security`, `ci`
- `store` and `mcp`, for the memory server
- `consistency`: manifests, built copies, docs and the demo agree

They include real pushes through the hooks, a fresh CI-style clone at the PR head, the workflow's actual shell step, and a regression test for every bug found so far.

## The demo

`docs/demo.gif` is rendered with [VHS](https://github.com/charmbracelet/vhs) from [`docs/demo.tape`](docs/demo.tape):

```bash
vhs docs/demo.tape
```

The consistency test runs the same commands, so the demo can't drift from what the gate does. Render it again whenever the gate's output changes.

## Releasing

`plugin.json` sets `version`, so people who installed the plugin only get an update when it changes. Bump it in `plugin.json` and `package.json` with every release, and add a CHANGELOG entry. Users update with `/plugin marketplace update comprende`, or by turning on auto-update for this marketplace in `/plugin`.
