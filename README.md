<p align="center"><img src=".claude-plugin/icon.png" width="120" alt=""></p>

<h1 align="center">Comprende</h1>

<p align="center"><b>Understand the code AI writes for you, and prove it before you merge.</b></p>

<p align="center"><a href="README.ar.md">Arabic</a></p>

Comprende is a plugin for Claude Code. It does two things:

1. **Claude explains the code it writes**, briefly and in your language, but only the parts worth explaining: new APIs, non-obvious logic, risks. This works in every project.
2. **The ownership check** (optional, per repo). Before your code is pushed, Claude asks you a few questions about it, and you write the PR summary. Without that, the push and the merge are blocked.

<p align="center">
  <a href="https://youtu.be/KeoRSyM0zu8"><img src="https://img.youtube.com/vi/KeoRSyM0zu8/maxresdefault.jpg" width="640" alt="Video: Stop Merging AI Code You Don't Understand"></a>
  <br>
  <a href="https://youtu.be/KeoRSyM0zu8">▶ Watch the video: Stop Merging AI Code You Don't Understand</a>
</p>

## Install

Run these two commands in your terminal. You need [Node.js](https://nodejs.org) 20+.

```bash
claude plugin marketplace add AbdulrahmanMasoud/comprende
claude plugin install comprende@comprende
```

Then restart Claude Code. To check it worked, type `/mcp` in Claude: **comprende** should be in the list.

This turns it on for **all your projects**. If you install from inside Claude with `/plugin` instead, pick the **user** scope: the project scope turns it on for one repo only.

## 1. Explanations: just use Claude

There's nothing to set up. Ask for code as usual, and Claude explains what's new, non-obvious or risky. A real reply, shortened:

> **You:** the search box sends a request on every keystroke. make it wait until the user stops typing
>
> **Claude:** I added a debounce to the search box in `search.js`, so it now sends one request after the user pauses instead of one per keystroke.
>
> **How it works:** each keystroke cancels the pending timer (`clearTimeout`) and starts a new one. `search()` only runs once 300ms pass with no typing.
>
> **One thing I added that you didn't ask for:** each new request now cancels the previous one with an `AbortController`. …
>
> **A security problem I didn't fix:** `r.title` goes straight into `innerHTML`. …

You can steer it, in any language:

| Say | What happens |
|---|---|
| "explain more", "why?" | One level deeper on that topic |
| "I know this", "skip" | Less on that topic, from now on |
| "just build" | No explanations until you ask. Risks still get one line |
| "check me" | An ownership check on your current change |

Claude remembers what you already know in `~/.comprende/`, on your machine only.

## 2. The ownership check

### Turn it on (team lead, once per repo)

1. Open Claude in the repo and say: **"Enable the ownership gate in this repo."**
2. Claude opens a PR that adds the gate (`.learning/`), a CI check and a Claude hook. Review `.learning/config.json`, mainly `sensitive`: paths like auth or payments, which always get questions. Then merge it.
3. Make the check required: run `node .learning/gate.mjs protect --apply`, or ask Claude to. It needs admin rights on GitHub.
4. Ask your team to install the plugin. That's all they need: their first session in the repo sets up the rest.

### Use it (every developer)

Work with Claude as usual. When you ask it to commit or push, or when you say **"check me"**:

1. Claude asks 1 to 6 questions about your change, one at a time. A small change gets one.
2. A wrong answer gets a short explanation, then a **different** question.
3. You write the PR summary yourself.
4. Claude saves a report in `.learning/checks/`, commits it with your code, and pushes.

A real session, shortened:

> **You:** add a sum(xs) function to math.js that adds up a list of numbers using add, then commit and push it
>
> **Claude:** I've added `sum` to `math.js`, but nothing is committed yet. This repo has the ownership gate on, so you need to answer one question and write a short summary before the commit and push. …
>
> **The question:** what happens with `sum([])` if we drop the `0` and write `xs.reduce(add)`? Why?
>
> **You:** it still returns 0, reduce starts from 0 by default
>
> **Claude:** Not quite. `reduce` has no default of `0`. Without a starting value, it uses the **first element** of the array as the starting point. An empty array has no first element, so it throws. …
>
> **One more on the same idea:** say we drop the `0`. What does `sum([5])` return, and how many times does `add` get called?
>
> **You:** it returns 5 and add is never called, because 5 becomes the start value. Summary: Added sum(xs), which adds up a list with add. It starts from 0 so an empty list returns 0 instead of throwing.
>
> **Claude:** `sum` is committed as `5740db1` and pushed to `origin/feature/sum`. … The report is in `.learning/checks/feature%2Fsum.md`, included in the same commit, so the CI check can match it to this code.

**If you skip the check**, Claude won't push, `git push` is blocked by a git hook, and CI fails the PR. This is what you see in a terminal:

![In a terminal: a push is blocked, the ownership report is saved, then the push goes through](docs/demo.gif)

### What the lead sees

On every PR, the **Ownership check** status, and a summary with the developer's own words and the concepts they explained for each file:

> ## ✅ Ownership check passed
> ### The developer's summary
> > Raised the public API rate limit from 10 to 60 per IP per minute because real users were getting blocked. If the gateway only sees the load balancer's IP, the limit becomes global, so verify X-Forwarded-For in staging first.
>
> | File | Concepts the developer explained |
> |---|---|
> | `src/middleware/rateLimit.js` | per-IP sliding window; window size vs effective limit; X-Forwarded-For behind a load balancer |
> | `src/auth/session.js` 🔒 | token expiry; why refresh is single-use |

The lead **never** sees scores, wrong answers or attempts. The goal is ownership, not surveillance.

## Try it in 5 minutes

Paste this into a terminal. It makes a throwaway repo with the check turned on, and a local folder that stands in for GitHub:

```bash
mkdir -p /tmp/comprende-try && cd /tmp/comprende-try
git clone -q https://github.com/AbdulrahmanMasoud/comprende.git
git init -q --bare -b main origin.git
git init -q -b main app && cd app && git remote add origin ../origin.git
echo 'export const add = (a, b) => a + b;' > math.js
git add -A && git commit -qm init
node ../comprende/dist/gate.mjs install --repo . > /dev/null
git add -A && git commit -qm "add ownership gate" && git push -q -u origin main
git checkout -q -b feature/sum
claude
```

Then, in Claude:

1. Say: **"add a sum(xs) function to math.js using add, then commit and push it"**.
2. Answer its question. Try a wrong answer first, to see what happens.
3. Write a one-line summary. Claude saves the report, commits and pushes.

## Learn more

- [**The gate for teams**](docs/teams.md): setup by hand, settings, small changes, emergencies
- [**How it works**](docs/how-it-works.md): requirements, fingerprints, the four layers, honest limits
- [**Contributing**](CONTRIBUTING.md): layout, tests, the demo, releases
- [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
