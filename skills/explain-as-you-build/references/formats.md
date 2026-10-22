# Formats

Templates, not scripts. Adapt wording to the user's language and the moment; keep the shape and the length.

## Tier 1 — one-line note

```
`retryWithBackoff` waits 1s, 2s, 4s… so a struggling server gets breathing room instead of a stampede.
```

One sentence. The *why* in the second half.

## Tier 2 — short block (default ceiling)

```
**<Name of the thing>** — <what it does, in one sentence>. <Why we need it here / what would go wrong without it>. <Optional: the gotcha or the alternative we didn't pick, and why>.
```

2–4 sentences. If you need a fifth, you're probably writing Tier 3 without being asked — cut.

## Tier 3 — deep dive (only on request)

Use structure, still keep each part short:

1. The idea in one sentence.
2. How it works — a tiny example or 3–5 step walkthrough.
3. Why it was the right choice here, and the alternatives.
4. Common mistakes / gotchas.
5. One thing to try.

A small diagram is welcome when the concept is about flow or structure.

## Plan (before non-trivial work)

```
Plan: <what we're building, one line>.
Shape: <the main pieces and how they connect, one or two lines>.
Key decision: <the one choice that matters most, and why>.
```

## Wrap-up (after building)

```
Now: <how the pieces fit together, 1–2 lines>.
Watch out: <one risk or limitation, if any>.
Try: <one concrete experiment that teaches something>.
```

Skip "Watch out" if there's nothing real. Never pad it.

## Codebase map (entering an unfamiliar project)

```
Entry points: <where requests/commands start>
Core modules: <3–6 names, each with a 3–6 word role>
Data flow: <A → B → C, one line>
Where to look first for <the user's task>: <file/folder>
```

~10 lines total. Offer to go deeper on any module rather than dumping everything.

## Decision note (lasting choices)

```
Decision: <what we chose> over <alternative> — <the reason, in one line>.
```

## Checkpoint (optional, at a natural pause)

```
Quick check (optional): <one question answerable in a sentence>?
```

Good checkpoint questions ask the user to *predict* or *transfer*: "What happens if two users hit this at once?" — not trivia like "What does `map` return?".

## Placement

- Put the explanation right after the chunk it describes, not batched at the end — context fades fast.
- Several small chunks with nothing worth saying → say nothing, then a single line later if needed.
- In silent mode, risk flags still go right where the risk is, prefixed with ⚠️.
