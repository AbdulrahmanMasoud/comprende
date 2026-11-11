# Codex recordings

Real replies from Codex's agent, recorded with [`tools/e2e-codex.mjs`](../../../tools/e2e-codex.mjs) while Codex support was built for 0.4.0. The READMEs' Codex examples quote them, shortened only with "…".

They live in `docs/`, not `test/fixtures/`: no test reads them. Fixtures are hook payloads that tests read, and Codex's are in [`test/fixtures/codex/`](../../../test/fixtures/codex/).

## How they were recorded

- **When and where:** 2026-11-11, on macOS, with the Codex CLI `0.167.1`, signed in with ChatGPT, with its default model.
- **Isolation:** a throwaway `HOME` and `CODEX_HOME`, holding only a copy of the maintainer's `auth.json`, deleted when the run ended.
- **The plugin:** this repo, installed with `codex plugin marketplace add` and `codex plugin add`, at the code of [#49](https://github.com/AbdulrahmanMasoud/comprende/pull/49) plus the install PR's branch.
- **`0.4.1-after-update/`:** the same setup, run by the maintainer with `--only after-update`, at the code of the 0.4.1 release ([#53](https://github.com/AbdulrahmanMasoud/comprende/pull/53), with [#52](https://github.com/AbdulrahmanMasoud/comprende/pull/52) and [#54](https://github.com/AbdulrahmanMasoud/comprende/pull/54)).
- **The hooks:** trusted the way `/hooks` does it, through Codex's app server.
- **The demo:** a gated repo with a local bare remote, and an unverified `sum(xs)` on `feature/sum`.
- **The replies:** each `.reply.md` holds every agent message of one turn, from `--json`. The demo's paths were replaced with `/work/…`. Nothing else was changed, and nothing personal is in them.
- **The language:** part-way through, Codex answered in Egyptian Arabic, though the prompts were English. The skill follows the user's language. That came from the signed-in account, not from this repo.

## The prompts

| Step | Prompt |
|---|---|
| `1-session-start` | Without running any tools: quote, word for word, the context you were given at the start of this session about Comprende and about an ownership gate. If there was none, say NONE. |
| `2-ls` | Run exactly this shell command once: `` `ls` ``. Then say what it printed. |
| `3-unverified-push` | Run exactly this shell command once, and don't retry or work around it if it's blocked: `` `git push -u origin feature/sum` ``. Quote any block message word for word. |
| `4-check-me` | check me |
| `5-answers` | sum totals the list with reduce. The 0 is the starting value, so an empty list gives 0 instead of throwing a TypeError. My summary for the PR, in my own words: Added sum(xs), which adds up a list of numbers with reduce, starting from 0 so an empty list returns 0. Please save the report now, then commit it, then push the branch as a separate command. |
| `6-memory` | Call the comprende memory server's learning_context tool for this project, and tell me in one line what it returned. |
| `7-explain-as-you-build` | Add a small function retryWithBackoff(fn, attempts) in retry.js that retries an async function, waiting with exponential backoff and full jitter between attempts. Don't commit. |
| `8-repo-hook-push`, `9-after-update-push` | Run exactly this shell command once, and don't retry or work around it if it's blocked: `` `git push -u origin feature/sum` ``. |
| `10-after-update-code` | Add a function mul(a, b) to math.js that multiplies two numbers. Don't commit. |

## What the run shows

`results.json` is the script's verdict per step: 15 passed, 2 failed.

- **"check me: questions asked" failed in the script, not in Codex.** The question in `4-check-me` ends with an Arabic question mark (`؟`), which the script's check didn't know. It does now.
- **"after an update: the skill says to trust the hooks again" failed.** With the plugin's hooks skipped, nothing told Codex to load the skill, so for a plain code task (`10-after-update-code`) it never read the skill's rule. A rerun with 0.4.0, whose description named code changes in a repo with `.learning/config.json`, failed too (its replies weren't kept): the agent looked for that file with `rg --files`, which skips hidden folders, and never opened the skill. A second rerun, with the skill's description saying to load it for any code change, failed the same way: Codex listed the new description, and its agent made the edit without opening the skill. The note now comes from the session start in the repo's `.codex/hooks.json`, which keeps its trust across plugin updates. Recorded in [`0.4.1-after-update/`](0.4.1-after-update/), all 4 steps passing: Codex skipped the plugin's hooks, the repo's session start still ran, the push was still blocked, and the agent said, mid-turn: "this session did not include Comprende's “Comprende is installed” note. Codex skips its hooks after plugin updates until they're trusted again in `/hooks`."
- **After an update, the repo's own `.codex/hooks.json` still blocked the push** (`9-after-update-push`): its trust lasts across plugin updates.
