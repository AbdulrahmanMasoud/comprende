I've added `retryWithBackoff` in [retry.js](file:///work/demo-explain/app/retry.js#L1-L12).

**Full jitter** — picks a random delay uniformly between 0 and the exponential cap (`Math.random() * maxDelay`). Without jitter, clients retrying at identical exponential intervals synchronize into a "thundering herd" that repeatedly re-crashes a recovering service. Full jitter spreads the retries across the time window to smooth traffic spikes.

```
Now: retryWithBackoff is exported from retry.js, taking fn, attempts = 3, and an optional baseDelay = 100ms.
Try: wrap an async call that fails twice to observe the randomized backoff times across attempts.
```

---

### Ownership Check (In-flight)
> **Quick check (optional)**: If two clients hit a failing service at the same moment, what problem occurs if we use pure exponential backoff *without* jitter, and how does full jitter prevent it?
