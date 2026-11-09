Closes #

## What changed

<!-- The change, in a few bullets. -->

## Why

<!-- The problem it solves, or the issue's goal. -->

## How it was tested

<!-- The commands you ran and what they printed (shortened). -->

```bash
npm run check
```

## Docs updated

<!-- Which docs changed (README.md + README.ar.md, docs/, SECURITY.md, skill references, CHANGELOG.md),
     or "none" and why. -->

## Fresh-eyes review

<!-- Someone who hadn't seen the work (another person, or a new AI session with none of your context)
     read the diff and the rules in CLAUDE.md, looking only at readability, design and missing tests.
     See "The fresh-eyes review" in CONTRIBUTING.md. -->

| What was flagged | What changed |
| --- | --- |
|  |  |

## Checklist

**Workflow**

- [ ] Branched from an up-to-date `main` as `feat/`, `fix/`, `docs/` or `chore/<name>`
- [ ] Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`)
- [ ] No AI attribution in the commits, the PR title or this description
- [ ] Every required CI check is green
- [ ] A user-visible change has an entry under `## Unreleased` in `CHANGELOG.md`

**Clean code**

- [ ] Each module owns one concern and starts with a header saying what it owns
- [ ] No file past ~300 lines or function past ~50 without a reason
- [ ] Tool- and platform-specific code lives in its adapter. The core has no "if cursor … else if codex …"
- [ ] Names say what things do
- [ ] No duplicated logic
- [ ] No `any`. Every non-null assertion has a comment saying why it's safe. External input is validated at the edge
- [ ] Comments explain why. No commented-out code, no dead code, no TODO without an issue number
- [ ] Tests are named after the behavior. A bug fix has a regression test that failed before the fix
- [ ] One feature or fix. Unrelated refactors are in their own `chore/` PR
- [ ] `src/` changed → `dist/` rebuilt with `npm run build`
- [ ] Lint and typecheck at zero warnings
