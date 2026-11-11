I'll follow the Comprende skill and check the project context before adding `retryWithBackoff`.Small new helper: loop up to `attempts`, on failure wait with full jitter (`random(0, base·2^i)`), then rethrow the last error. Writing `retry.js` to match `math.js` style.Added `retry.js` with `retryWithBackoff(fn, attempts)`.

**Full jitter** is the useful bit: instead of sleeping a fixed `base · 2^attempt`, you sleep a random time in `[0, base · 2^attempt]`. That spreads retries so clients don’t hammer the server in sync after an outage. Base delay is `100ms`; last failure is rethrown after the final attempt.

No commit, as requested.

Quick check (optional): if three clients all fail on attempt 0 with the same base, why does full jitter beat “always wait exactly 100ms”?