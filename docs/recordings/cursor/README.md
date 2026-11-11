# Cursor recordings

Real replies from Cursor's agent, recorded with [`tools/e2e-cursor.mjs`](../../../tools/e2e-cursor.mjs) while Cursor support was built for 0.3.0. The READMEs' Cursor example quotes them, shortened only with "…": [`run-2/3-unverified-push.reply.md`](run-2/3-unverified-push.reply.md), [`run-2/4-check-me.reply.md`](run-2/4-check-me.reply.md) and [`run-2/4-answers.reply.md`](run-2/4-answers.reply.md).

They live in `docs/`, not `test/fixtures/`. No test reads them, and fixtures are hook payloads that tests do read. These are the evidence behind the docs' example replies, which are never written by hand.

## How they were recorded

- **When and where:** 2026-11-11, on macOS, with the Cursor CLI (`cursor-agent`) `2026.11.10-731fb78` and its default model, `Auto`.
- **Isolation:** a throwaway `HOME` holding only a copy of `~/.cursor/cli-config.json`, so no other settings or plugins loaded. This repo was loaded as the plugin with `--plugin-dir`.
- **The demo repo:** a gated repo with a local bare remote, and an unverified `sum(xs)` on `feature/sum` (`makeDemo` in the script).
- **The code:**
  - runs 1 and 2: the branch of [#41](https://github.com/AbdulrahmanMasoud/comprende/pull/41) before its review fixes
  - run 3: that branch after them
- **Each `.reply.md` is one agent turn:** the `result` text from `--output-format stream-json`. Personal data was checked for, and there was none. Paths, chat ids and the account aren't in the replies.

## The prompts

Runs 1 and 2 used earlier drafts of the script, so their step numbers differ from today's. These are run 2's prompts, word for word. Run 1 asked the same things, numbered differently (`5-answers`), but its exact wording wasn't kept.

| Step | Prompt |
|---|---|
| `1-session-start` | Without running any tools: quote, word for word, the context you were given at the start of this session about Comprende and about an ownership gate. If there was none, say NONE. |
| `2-ls` | Run exactly this shell command once: `` `ls` ``. Then say what it printed. |
| `3-unverified-push` | Run exactly this shell command once, and don't retry or work around it if it's blocked: `` `git push -u origin feature/sum` ``. Quote any block message word for word. |
| `4-check-me`, `6-no-memory-check-me` | check me |
| `4-answers`, `6-no-memory-answers` | sum totals the list with reduce. The 0 is the starting value, so an empty list gives 0 instead of throwing a TypeError. My summary for the PR, in my own words: Added sum(xs), which adds up a list of numbers with reduce, starting from 0 so an empty list returns 0. Please save the report now, then commit it, then push the branch as a separate command. |
| `7-memory` | Call the comprende memory server's learning_context tool for this project, and tell me in one line what it returned. |
| `8-explain-as-you-build` | Add a small function retryWithBackoff(fn, attempts) in retry.js that retries an async function, waiting with exponential backoff and full jitter between attempts. Don't commit. |
| `9-both-plugins`, with the Claude Code plugin imported as well | Run exactly this shell command once, and don't retry or work around it if it's blocked: `` `git push -u origin feature/sum` ``. |

## What each run shows

`results.json` in each folder is the script's verdict per step.

- **Run 1:** every step passed but one. "Saved with `save --input`" failed because the agent used the memory server's `save_check_report`, which the skill prefers when the server is there. Steps 8 and 9 are the only recordings of explain-as-you-build and of the both-plugins push.
- **Run 2:** the "no memory" turns (`6-…`) still had the memory server. Leaving out `--approve-mcps` didn't remove it, and the script now loads a plugin copy without one. Steps 8 and 9 were cut off by the account's usage limit, so they have no reply.
- **Run 3:** after the review fixes. It has only `results.json`. With the Claude Code plugin imported too, session start gave the always-on line once and the gate's context once. The rest was blocked by the usage limit.
