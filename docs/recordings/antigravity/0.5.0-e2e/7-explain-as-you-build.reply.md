Added `retryWithBackoff` in [retry.js](file:///work/demo-explain/app/retry.js).

**Full jitter backoff** — On failure, `retryWithBackoff` multiplies the base delay by $2^{\text{attempt}}$ up to a cap, then picks a uniform random interval between 0 and that value (`Math.random() * delay`). We use full jitter over deterministic backoff because when an outage impacts many concurrent requests, deterministic delays cause all clients to retry in lockstep pulses (a thundering herd). Jitter desynchronizes them across the retry window.

Quick check (optional): What would happen to a recovering downstream service if dozens of failed clients retried using fixed exponential backoff without any jitter?
