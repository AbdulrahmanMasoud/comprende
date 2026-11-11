// End-to-end check of Comprende in Codex, with the real Codex CLI. Not in CI: it
// needs a Codex sign-in, and it uses the account's requests. See "Testing in
// Codex" in CONTRIBUTING.md.
//
//   node tools/e2e-codex.mjs --login <auth.json> | (CODEX_API_KEY in the environment)
//                            [--out <folder>] [--model <name>] [--only <scenario>,…]
//
// --login copies that auth.json into the run's throwaway CODEX_HOME, and deletes the
// copy when the run ends. Scenarios, each in its own gated demo repo:
//   main         session start, an ordinary command, an unverified push, "check me"
//                through to a push that goes through, and the memory server
//   explain      explain-as-you-build: only the non-obvious part explained
//   repo-hook    the plugin and the repo's .codex/hooks.json both trusted: one check
//   after-update a file changed in the installed plugin: Codex skips its hooks, and
//                the skill says to trust them again
// This repo is installed as the plugin (`codex plugin marketplace add <this repo>`),
// and its hooks are trusted the way /hooks does it, through Codex's app server.
// Every gate.mjs run is logged (a NODE_OPTIONS preload). It prints one line per
// step, PASS, FAIL or BLOCKED (Codex refused to run, e.g. a usage limit), and saves
// transcripts and replies to --out. Nothing is pushed anywhere: remotes are local.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (/** @type {string} */ name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const RUN = resolve(opt("--out") ?? mkdtempSync(join(tmpdir(), "comprende-e2e-codex-")));
const MODEL = opt("--model");
const ONLY = opt("--only")?.split(",");
const LOGIN = opt("--login");
const CODEX =
  process.env.CODEX_BIN ?? spawnSync("/bin/sh", ["-c", "command -v codex"], { encoding: "utf8" }).stdout.trim();
if (!CODEX) throw new Error("codex isn't installed: https://learn.chatgpt.com/docs/codex/cli (or set CODEX_BIN)");
if (!LOGIN && !process.env.CODEX_API_KEY) throw new Error("pass --login <auth.json>, or set CODEX_API_KEY");

mkdirSync(RUN, { recursive: true });
const HOME = join(RUN, "home");
const CODEX_HOME = join(RUN, "codex-home");
mkdirSync(HOME, { recursive: true });
mkdirSync(CODEX_HOME, { recursive: true });
if (LOGIN) cpSync(LOGIN, join(CODEX_HOME, "auth.json"));

/** @type {{ step: string, status: "PASS" | "FAIL" | "BLOCKED", detail?: string | undefined }[]} */
const results = [];
/** @param {string} step @param {boolean} ok @param {string} [detail] */
const report = (step, ok, detail) => {
  results.push({ step, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
};

/** Codex refused to run a turn: a usage limit, or the sign-in. */
class Blocked extends Error {}

// ---------------------------------------------------------------- running codex

const LOG = join(RUN, "gate-runs.jsonl");
const PRELOAD = join(RUN, "log-gate-runs.mjs");
writeFileSync(
  PRELOAD,
  `import { appendFileSync } from "node:fs";
if ((process.argv[1] ?? "").endsWith("gate.mjs")) {
  const seen = { stdout: [], stderr: [] };
  for (const stream of ["stdout", "stderr"]) {
    const write = process[stream].write.bind(process[stream]);
    process[stream].write = (c, ...r) => { seen[stream].push(String(c)); return write(c, ...r); };
  }
  process.on("exit", (code) => appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), exit: code, stdout: seen.stdout.join(""), stderr: seen.stderr.join("") }) + "\\n"));
}
`,
);
/** @returns {{ argv: string[], cwd: string, exit: number, stdout: string, stderr: string }[]} */
const gateRuns = () =>
  existsSync(LOG)
    ? readFileSync(LOG, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

const ENV = {
  HOME,
  CODEX_HOME,
  PATH: process.env.PATH,
  USER: process.env.USER ?? "",
  LANG: "en_US.UTF-8",
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  COMPRENDE_HOME: join(RUN, "comprende-home"),
  NODE_OPTIONS: `--import=${pathToFileURL(PRELOAD).href}`,
  ...(process.env.CODEX_API_KEY ? { CODEX_API_KEY: process.env.CODEX_API_KEY } : {}),
};

/** @param {string} cwd @param {string[]} argv @param {string} [input] */
const codex = (cwd, argv, input) =>
  spawnSync(CODEX, argv, { cwd, env: ENV, encoding: "utf8", input: input ?? "", timeout: 600_000 });

/** One request to Codex's app server, the API its own TUI uses. @param {string} cwd @param {{ method: string, params: object }} request */
function appServer(cwd, request) {
  const lines = [
    { method: "initialize", id: 1, params: { clientInfo: { name: "comprende-e2e", version: "1" } } },
    { method: "initialized" },
    { ...request, id: 2 },
  ];
  // The server answers, then waits for more: end stdin after a moment.
  const r = spawnSync("/bin/sh", ["-c", `(cat; sleep 8) | "${CODEX}" app-server`], {
    cwd,
    env: ENV,
    encoding: "utf8",
    input: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    timeout: 60_000,
  });
  for (const line of (r.stdout ?? "").split("\n")) {
    try {
      const reply = JSON.parse(line);
      if (reply.id === 2) return reply.result;
    } catch {
      /* not a reply */
    }
  }
  throw new Error(`no reply from codex app-server to ${request.method}: ${r.stderr}`);
}

/** Trust a project and every hook it would run, as Codex's prompts and /hooks do. @param {string} app @returns {string[]} the hooks' keys */
function trust(app) {
  appServer(app, {
    method: "config/batchWrite",
    params: {
      edits: [{ keyPath: "projects", value: { [app]: { trust_level: "trusted" } }, mergeStrategy: "upsert" }],
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: true,
    },
  });
  const hooks = appServer(app, { method: "hooks/list", params: { cwds: [app] } }).data[0].hooks;
  /** @type {Record<string, { trusted_hash: string }>} */
  const value = {};
  for (const h of hooks) if (h.trustStatus !== "trusted") value[h.key] = { trusted_hash: h.currentHash };
  appServer(app, {
    method: "config/batchWrite",
    params: {
      edits: [{ keyPath: "hooks.state", value, mergeStrategy: "upsert" }],
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: true,
    },
  });
  return hooks.map((/** @type {{ key: string }} */ h) => h.key);
}

/** @typedef {{ reply: string, session: string | undefined, commands: { command: string, exit: number | null, output: string }[], tools: string[] }} Turn */

/**
 * One headless Codex turn: a new session in `app`, or `resume` one. Throws Blocked
 * when Codex refuses to run it.
 * @param {string} name @param {string} app @param {string} prompt @param {{ resume?: string | undefined }} [options]
 * @returns {Turn}
 */
function turn(name, app, prompt, { resume } = {}) {
  const lastMessage = join(RUN, `${name}.reply.md`);
  // The sandbox may write the demo, its .git (to commit) and its local remote (to push).
  const sandbox = [
    "-c",
    'sandbox_mode="workspace-write"',
    "-c",
    `sandbox_workspace_write.writable_roots=${JSON.stringify([join(app, ".git"), join(dirname(app), "origin.git")])}`,
  ];
  const common = ["--json", "--skip-git-repo-check", "-o", lastMessage, ...(MODEL ? ["-m", MODEL] : [])];
  const argv = resume
    ? ["exec", ...sandbox, "resume", ...common, resume, prompt]
    : ["exec", ...sandbox, ...common, prompt];
  const r = codex(app, argv);
  writeFileSync(join(RUN, `${name}.jsonl`), r.stdout ?? "");
  writeFileSync(join(RUN, `${name}.stderr.txt`), `exit ${r.status ?? r.signal}\n${r.stderr ?? ""}`);
  const events = (r.stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  const refused = events.find(
    (e) => e.type === "error" && /usage limit|rate limit|unauthorized|log ?in/i.test(e.message ?? ""),
  );
  if (refused && !existsSync(lastMessage)) throw new Blocked(refused.message);
  const items = events.filter((e) => e.type === "item.completed").map((e) => e.item);
  return {
    reply: existsSync(lastMessage) ? readFileSync(lastMessage, "utf8") : "",
    session: events.find((e) => e.type === "thread.started")?.thread_id,
    commands: items
      .filter((i) => i.type === "command_execution")
      .map((i) => ({ command: i.command, exit: i.exit_code ?? null, output: i.aggregated_output ?? "" })),
    tools: items.filter((i) => i.type === "mcp_tool_call").map((i) => `${i.server}:${i.tool}`),
  };
}

// ---------------------------------------------------------------- the plugin and the demo repo

/** @param {string} cwd @param {...string} a */
const git = (cwd, ...a) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

/** This repo as a marketplace, and Comprende installed from it. */
function installPlugin() {
  for (const argv of [
    ["plugin", "marketplace", "add", REPO],
    ["plugin", "add", "comprende@comprende"],
  ]) {
    const r = codex(RUN, argv);
    if (r.status !== 0) throw new Error(`codex ${argv.join(" ")}: ${r.stderr}`);
  }
}

/** A repo with the gate on main, and an unverified `sum` on feature/sum. @param {string} name */
function makeDemo(name) {
  const dir = join(RUN, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(dir, "init", "-q", "-b", "main", "app");
  const app = join(dir, "app");
  git(app, "config", "user.name", "Demo");
  git(app, "config", "user.email", "demo@example.invalid");
  git(app, "remote", "add", "origin", "../origin.git");
  writeFileSync(join(app, "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  git(app, "add", "-A");
  git(app, "commit", "-qm", "init");
  git(app, "push", "-q", "-u", "origin", "main");
  spawnSync(process.execPath, [join(REPO, "dist", "gate.mjs"), "install", "--repo", app], { encoding: "utf8" });
  git(app, "add", "-A");
  git(app, "commit", "-qm", "add the ownership gate");
  git(app, "push", "-q", "--no-verify", "origin", "main");
  git(app, "checkout", "-q", "-b", "feature/sum");
  writeFileSync(
    join(app, "math.js"),
    `${readFileSync(join(app, "math.js"), "utf8")}\nexport function sum(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n`,
  );
  git(app, "commit", "-qam", "add sum");
  return { app, remote: join(dir, "origin.git") };
}

/** @param {string} remote @param {string} branch */
const remoteHas = (remote, branch) =>
  spawnSync("git", ["rev-parse", "--verify", "-q", branch], { cwd: remote }).status === 0;

/** The checks that blocked a push since `from`: the agents' hook, not git's pre-push. @param {number} from */
const hookChecks = (from) =>
  gateRuns()
    .slice(from)
    .filter((r) => r.exit === 2 && (r.argv.includes("agent-hook") || r.argv.includes("claude-hook")));

const PUSH =
  "Run exactly this shell command once, and don't retry or work around it if it's blocked: `git push -u origin feature/sum`.";

const ANSWER =
  "sum totals the list with reduce. The 0 is the starting value, so an empty list gives 0 instead of throwing a TypeError. " +
  "My summary for the PR, in my own words: Added sum(xs), which adds up a list of numbers with reduce, starting from 0 so an empty list returns 0. " +
  "Please save the report now, then commit it, then push the branch as a separate command.";

// ---------------------------------------------------------------- the scenarios

function main() {
  const demo = makeDemo("demo");
  const trusted = trust(demo.app);
  report("the plugin's hooks and the repo's are trusted", trusted.length >= 3, trusted.join(", "));
  const start = turn(
    "1-session-start",
    demo.app,
    "Without running any tools: quote, word for word, the context you were given at the start of this session about Comprende and about an ownership gate. If there was none, say NONE.",
  );
  report("session start: the always-on line", /Comprende is installed/.test(start.reply));
  report("session start: the gate's message", /This repository uses the ownership gate/.test(start.reply));
  const session = start.session;

  const before = gateRuns().length;
  const ls = turn("2-ls", demo.app, "Run exactly this shell command once: `ls`. Then say what it printed.", {
    resume: session,
  });
  const lsRuns = gateRuns()
    .slice(before)
    .filter((r) => r.argv.includes("agent-hook") || r.argv.includes("claude-hook"));
  report(
    "an ordinary command runs, and the hook is silent",
    ls.commands.some((c) => /\bls\b/.test(c.command) && c.exit === 0) &&
      lsRuns.length > 0 &&
      lsRuns.every((r) => r.exit === 0 && r.stdout === ""),
    `${lsRuns.length} hook run(s)`,
  );

  // Codex's hook, not git's: the session start installs the git hook again, so it's counted apart.
  const pushFrom = gateRuns().length;
  const push = turn("3-unverified-push", demo.app, `${PUSH} Quote any block message word for word.`, {
    resume: session,
  });
  report(
    "an unverified push is blocked by Codex's hook, once, and the agent sees why",
    !remoteHas(demo.remote, "feature/sum") &&
      hookChecks(pushFrom).length === 1 &&
      /Ask Codex to run the ownership check/.test(push.reply),
    `${hookChecks(pushFrom).length} check(s)`,
  );

  const asked = turn("4-check-me", demo.app, "check me", { resume: session });
  report("check me: questions asked", /\?/.test(asked.reply));
  const turns = [asked, turn("5-answers", demo.app, ANSWER, { resume: session })];
  for (let i = 0; i < 2 && !remoteHas(demo.remote, "feature/sum"); i++)
    turns.push(
      turn(
        `5-follow-up-${i + 1}`,
        demo.app,
        "Please finish: save the report if it isn't saved, commit it, then run `git push -u origin feature/sum` as a separate command.",
        { resume: session },
      ),
    );
  const saved = turns.some((t) => t.tools.some((tool) => /save_check_report/.test(tool)))
    ? "the memory server"
    : turns.some((t) => t.commands.some((c) => /gate\.mjs"? save/.test(c.command)))
      ? "save --input"
      : null;
  report("check me: the report saved", saved !== null, `with ${saved}`);
  report("check me: committed, then a separate push goes through", remoteHas(demo.remote, "feature/sum"));
  const trailer = git(demo.app, "log", "-1", "--format=%B").match(/^Co-authored-by: .*/m)?.[0] ?? "none";
  report("the agent's commit: its trailer", true, trailer);

  const memory = turn(
    "6-memory",
    demo.app,
    "Call the comprende memory server's learning_context tool for this project, and tell me in one line what it returned.",
    { resume: session },
  );
  report(
    "the memory server: learning_context works",
    memory.tools.some((t) => /learning_context/.test(t)),
    memory.tools.join(", "),
  );
}

function explain() {
  const { app } = makeDemo("demo-explain");
  git(app, "checkout", "-q", "-b", "feature/retry", "main");
  trust(app);
  const t = turn(
    "7-explain-as-you-build",
    app,
    "Add a small function retryWithBackoff(fn, attempts) in retry.js that retries an async function, waiting with exponential backoff and full jitter between attempts. Don't commit.",
  );
  report("explain as you build: retry.js written", existsSync(join(app, "retry.js")));
  report(
    "explain as you build: a short explanation of the non-obvious part",
    /jitter/i.test(t.reply) && t.reply.length < 2500,
    `${t.reply.length} characters; read 7-explain-as-you-build.reply.md`,
  );
}

// The plugin and the repo's .codex/hooks.json, both trusted: they claim the push, so one checks.
function repoHook() {
  const demo = makeDemo("demo-repo-hook");
  const keys = trust(demo.app);
  report(
    "the repo's .codex/hooks.json is trusted too",
    keys.some((k) => k.includes(".codex/hooks.json")),
    keys.join(", "),
  );
  const from = gateRuns().length;
  turn("8-repo-hook-push", demo.app, PUSH);
  const runs = gateRuns()
    .slice(from)
    .filter((r) => r.argv.includes("agent-hook"));
  report(
    "the plugin and the repo's hook: one check per push",
    hookChecks(from).length === 1 && runs.length >= 2 && !remoteHas(demo.remote, "feature/sum"),
    `${runs.length} run(s), ${hookChecks(from).length} check(s)`,
  );
}

// Any change to the installed plugin's files skips its hooks until they're trusted again.
function afterUpdate() {
  const demo = makeDemo("demo-after-update");
  trust(demo.app);
  const cache = join(CODEX_HOME, "plugins", "cache", "comprende", "comprende");
  const [version] = spawnSync("ls", [cache], { encoding: "utf8" }).stdout.trim().split("\n");
  const marker = join(cache, version, "CHANGED-BY-E2E.txt");
  writeFileSync(marker, "a change, as an update makes\n");
  try {
    const from = gateRuns().length;
    const t = turn("9-after-update", demo.app, "Run exactly this shell command once: `ls`. Then say what it printed.");
    const pluginRuns = gateRuns()
      .slice(from)
      .filter((r) => r.argv.includes("--from-plugin"));
    report(
      "after an update: Codex skips the plugin's hooks",
      pluginRuns.length === 0,
      `${pluginRuns.length} plugin hook run(s)`,
    );
    report(
      "after an update: the skill says to trust the hooks again",
      /\/hooks/.test(t.reply),
      "read 9-after-update.reply.md",
    );
  } finally {
    rmSync(marker, { force: true });
  }
}

const SCENARIOS = { main, explain, "repo-hook": repoHook, "after-update": afterUpdate };
try {
  installPlugin();
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (ONLY && !ONLY.includes(name)) continue;
    try {
      run();
    } catch (e) {
      if (!(e instanceof Blocked)) throw e;
      results.push({ step: name, status: "BLOCKED", detail: e.message });
      console.log(`BLOCKED  ${name}: the rest wasn't run. Codex said: ${e.message}`);
    }
  }
} finally {
  // The copied sign-in goes as soon as the run ends, whatever happened.
  rmSync(join(CODEX_HOME, "auth.json"), { force: true });
  appendFileSync(join(RUN, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
}
console.log(`\nTranscripts and replies: ${RUN}`);
process.exitCode = results.every((r) => r.status === "PASS") ? 0 : 1;
