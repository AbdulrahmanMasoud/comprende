I’ll read the repo guidance and the comprende ownership-check instructions first, then add `retryWithBackoff` in the project’s existing style. I’ll also ask the required brief ownership questions while I work; I won’t commit.

There’s no `retry.js` or package metadata in the checkout yet, so I’m checking the repo’s conventions and the ownership-gate reference before creating the file. For ownership, two quick questions: is this retry helper meant for a particular caller, and should it retry every rejection or only selected errors? I’ll use the general-purpose defaults unless the repo gives a clearer answer.

The repo has no retry-specific decisions, and its existing JavaScript uses named exports. I’m treating `attempts` as the total number of calls, retrying any rejection, with a 100 ms starting ceiling, doubling up to a 30 s ceiling, and choosing each wait uniformly from zero to that ceiling (full jitter).

`retryWithBackoff` now returns the first successful result and rethrows the final error after the last call. The jitter is applied to the wait ceiling after each failure; `attempts` must be a positive integer. I’m checking the gate’s final status now so I can ask only the ownership questions this change requires.

Ownership check
- I’ll explain the behavior and write the summary

Added [retry.js](/work/demo-explain/app/retry.js). It treats `attempts` as the total number of calls, retries any rejection, and uses full jitter with a 100 ms starting ceiling capped at 30 seconds. Invalid attempt counts throw a `RangeError`.

I didn’t commit or run tests. The required ownership report is still unsaved: the gate asks you to explain what happens after the final failure, why the wait ceiling grows with jitter, and provide a 3–5 line summary of the change, its purpose, and what could break.
