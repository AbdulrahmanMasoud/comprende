Let's do the ownership check on `feature/sum`. It's a small change (adding `sum(xs)` to [math.js](file:///work/demo/app/math.js#L5-L7)), so just one question:

In `sum(xs)`, why is `0` passed as the second argument to `xs.reduce(...)`, and what would happen if someone called `sum([])` without it?
