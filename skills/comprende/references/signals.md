# Signals: when to explain, and how to read the user

Use this when a chunk is borderline, or when you're unsure where the user stands on a topic.

## Part 1 — Code signals (does this chunk deserve words?)

Think of it as a score. One strong signal is enough for a Tier 2 note. Several weak ones together are worth a Tier 1 line. None → silent.

### Strong signals (usually Tier 2)

**New or rare**
- APIs, language features, or library versions released recently or rarely seen in typical codebases (e.g. `AbortSignal.any()`, `Promise.withResolvers()`, `using` declarations, Python `match` with guards, Postgres `MERGE`).
- A library the project hasn't used before.
- Syntax that reads differently from what most people expect (e.g. Python's `for ... else`, JS labeled `break`, Go's named returns with defer).

**Non-obvious logic**
- Loops that don't iterate the obvious way: two pointers, iterating backwards to allow safe removal, sliding windows, early exits that carry meaning.
- Bit manipulation, modular arithmetic, off-by-one adjustments that are intentional.
- Regexes beyond trivial ones.
- Recursion, memoization, or generators where control flow isn't linear.
- Ordering that matters but doesn't look like it (middleware order, migration order, `useEffect` dependency choices).

**Hidden coupling / invariants**
- "This must run before that."
- A value assumed to be sorted, unique, non-null, or within a range.
- Two places that must stay in sync (a cache and its source, a type and its validator, an enum in DB and code).

**Real decisions**
- You chose between reasonable options: library A vs B, SQL vs NoSQL, polling vs webhooks, optimistic vs pessimistic locking, cache-aside vs write-through.
- You chose *not* to do something obvious (no retries here, no index there) on purpose.

**Risk**
- Security: auth checks, input validation, secrets handling, SQL/command injection boundaries, CORS, CSRF.
- Concurrency: shared state, race conditions, locks, idempotency.
- Performance: N+1 queries, unbounded loops or memory, missing pagination.
- Data: destructive migrations, deletes, irreversible operations.
- Compatibility: breaking API changes, behavior changes callers rely on.

### Weak signals (alone → Tier 1 or silent)

- A small configuration choice with a sensible default.
- A helper that's slightly clever but well-named.
- A test that covers an edge case worth knowing exists.

### Not worth words (silent)

- Imports, boilerplate, scaffolding, generated code.
- Standard CRUD, standard routing, standard component structure the user has already seen.
- Renames, formatting, moving code without behavior change (mention in one line at most, in the wrap-up).
- Anything already explained in this session.

## Part 2 — User signals (how deep, for this topic?)

Calibrate **per topic**. Keep a mental note like: `React hooks: knows well · Docker: learning · SQL indexing: unknown`.

### Evidence they know a topic → go lighter
- They use the precise term unprompted ("we need this to be idempotent").
- Their own code in the repo uses the pattern correctly, especially advanced forms of it.
- They ask about trade-offs, edge cases, or performance rather than "what is".
- They say "I know", "skip", "go on", or skim past explanations without questions.
- They correct you on a detail.

### Evidence they're learning a topic → go deeper
- They ask "what is X" / "what does X mean".
- They describe a concept slightly wrong, or misuse a term.
- They say "not sure", "lost", "I don't get it", or ask for an example.
- They copy a pattern without adapting it where it needed adapting.

### Evidence about the person overall (weak — don't overfit)
- Size and maturity of the codebase, presence of tests/CI, commit style.
- How they phrase requests (spec-like and precise vs. goal-oriented and loose).

Treat these as priors only. Topic-level evidence always wins. A staff engineer can be new to a tool; a student can be excellent at one thing.

## Part 3 — Tricky cases

- **Senior + new thing**: explain the new thing at Tier 1–2, in senior register (no basics, straight to what's different and the gotcha).
- **Learner + routine thing they've seen twice**: stay silent. Repetition teaches less than trust does.
- **User asked to "explain every line"**: honor the intent, not the letter — group trivial lines ("lines 1–8 are imports and setup") and spend words where the meaning is.
- **User is in a hurry / bug in production**: silent except risks. Offer a short "what happened and why" after the fix.
- **You made a mistake and fixed it**: say so in one line and explain the actual cause — that's often the most educational moment of the session.
- **Unsure whether they know it**: one-line note with an implicit offer ("…happy to dig into how the event loop handles this"). Their reaction tells you the rest.
