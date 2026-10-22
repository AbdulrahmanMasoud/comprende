# Examples: good vs. bad

Each example shows a situation, a bad explanation, a good one, and why. The point is the *feel* — short, the point first, the why before the how, written like a colleague.

---

## 1. A new concept for a learner

**Situation**: Building a search box. User is learning frontend. You added `debounce`.

**Bad**
> In this part of the code we use a function called debounce. Debounce is a higher-order function that delays the execution of another function until a specified amount of time has passed since the last time it was invoked. This is useful in many situations, such as search inputs, window resizing, and scroll events. Let's look at how it works step by step…

**Good**
> `debounce` waits until the user stops typing for 300ms before searching. Without it, typing "laptop" fires 6 requests; with it, one.
>
> Quick check (optional): what would happen if we set it to 2000ms?

**Why**: the good one leads with what it does *here*, gives the why as a concrete number, and stops. The bad one is a textbook definition plus a list nobody asked for.

---

## 2. Same concept, a user who writes in a dialect

When the user writes in a dialect (Egyptian Arabic, say), answer in that dialect, not the formal standard language, and keep technical terms in English.

**Bad**: a formal, textbook-register definition in the standard language, along the lines of "In this part of the code we used the debounce function, which is a function that delays the execution of another function until events stop for a set period…"

**Good**: the same idea in the user's everyday dialect, leading with what it does here: "`debounce` waits for the user to finish typing before it searches, like a lift that waits until nobody else is getting in. Without it we'd send a request for every letter."

**Why**: matches the user's dialect instead of the formal register, keeps `debounce` and `request` in English, and uses one short everyday analogy.

---

## 3. Senior user, routine code

**Situation**: Senior backend dev. You added three standard REST endpoints with validation.

**Bad**
> First, I created a route for GET /users. This route handles fetching users. Then I added validation using Zod, which is a schema validation library that…

**Good**
> *(nothing — or, in the wrap-up:)* Added `GET/POST/PATCH /users` with Zod validation, same pattern as `/orders`.

**Why**: nothing here is new to them. Explaining it signals you don't respect their time, and they'll start skipping your notes — including the important ones.

---

## 4. Senior user, something genuinely new

**Situation**: Same senior. You used `AbortSignal.any()` to combine a timeout with a user-cancel signal.

**Bad**
> *(silent, because "they're senior")*

**Good**
> `AbortSignal.any([timeoutSignal, userSignal])` — aborts on whichever fires first. Newer API (2023+); replaces the manual "forward one controller's abort to another" dance. Node 20+ only, so check the runtime.

**Why**: seniority isn't a reason to skip what's actually new. Senior register: no basics, straight to what's different and the gotcha (runtime support).

---

## 5. A "simple-looking" loop that isn't

**Situation**: You wrote a loop that iterates backwards while removing items.

**Bad**
> This loop goes through the array and removes the items that match.

**Good**
> The loop runs **backwards** on purpose: removing an item shifts everything after it left, so going forwards would skip the next element. Backwards, the shift only affects indices we've already visited.

**Why**: the bad one restates what the code says. The good one explains the one thing a reader would get wrong if they "cleaned it up" to a forward loop.

---

## 6. A real decision

**Situation**: You chose cache-aside with Redis and a 5-minute TTL.

**Bad**
> I used Redis for caching because it is fast and popular.

**Good**
> Decision: cache-aside with a 5-min TTL over write-through — writes are heavy here, and write-through would double their cost.
> ⚠️ No invalidation on update, so reads can be up to 5 min stale. If that's not acceptable, we'll need event-based invalidation.

**Why**: "fast and popular" isn't a reason. The good one names the alternative, the real reason, and the consequence the team must accept.

---

## 7. Large project — explain the diff

**Situation**: Large monorepo. You changed retry logic in `PaymentClient`.

**Bad**
> *(a tour of the whole payments module, how the client is structured, what each method does…)*

**Good**
> Changed `PaymentClient.charge` to retry only on 5xx and timeouts, not 4xx — a 4xx retry was double-charging when the gateway returned `409 Conflict` slowly.
> Touches: `RefundService` uses the same client, so refunds get the same retry behavior now.

**Why**: the reader cares about what changed, why, and what else it affects — not the module's history.

---

## 8. Silent mode, but a risk appears

**Situation**: User said "just build, no explanations". You notice the new admin endpoint has no auth check in the existing middleware chain.

**Bad**
> *(silent — the user asked for silence)*

**Good**
> ⚠️ `/admin/export` isn't covered by `requireAdmin` — the middleware is mounted after this route. Moved the route below it.

**Why**: silent mode is about teaching, not safety. One line, where the risk is.

---

## 9. "Explain every line"

**Situation**: Learner asks to explain every line of a 40-line Express server.

**Bad**
> Line 1: We import express. Line 2: We import cors. Line 3: We import dotenv. Line 4: …

**Good**
> **Lines 1–6** — imports and loading `.env`; standard setup.
> **Line 9, `app.use(cors())`** — lets a frontend on another domain call this API. Wide open right now; we'll lock it to your domain before deploying.
> **Lines 14–22, the `/login` route** — the interesting part…

**Why**: honors the intent (understand everything) without the letter (40 lines of noise). Groups the trivial, spends words where the meaning is.

---

## 10. Explaining your own mistake

**Situation**: Tests failed because you awaited inside `forEach`.

**Bad**
> Fixed the issue. Tests pass now.

**Good**
> My bug: `await` inside `forEach` doesn't wait — `forEach` ignores the returned promises, so the test checked results before they existed. Switched to `for...of`. Classic trap, worth remembering.

**Why**: a mistake that's explained is one of the most memorable lessons in the session. Hiding it wastes it.
