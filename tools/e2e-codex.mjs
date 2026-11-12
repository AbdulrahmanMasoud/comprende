// End-to-end check of Comprende in Codex, with the real Codex CLI. Not in CI: it
// needs a Codex sign-in, and it uses the account's requests. See "Testing in
// Codex" in CONTRIBUTING.md.
//
//   node tools/e2e-codex.mjs --login <auth.json> | (CODEX_API_KEY in the environment)
//                            [--out <folder>] [--model <name>] [--only <scenario>,…]
//
// --login copies that auth.json into the run's throwaway CODEX_HOME, and deletes the
// copy when the run ends, Ctrl-C included. Scenarios, each in its own gated demo repo:
//   main         the plugin alone: session start, an ordinary command, an unverified
//                push, "check me" through to a push that goes through, the commit's
//                trailer, and the memory server
//   explain      explain-as-you-build: only the non-obvious part explained
//   repo-hook    the plugin and the repo's .codex/hooks.json both trusted: both run,
//                one checks
//   after-update a file changed in the installed plugin: Codex skips its hooks, the
//                repo's trusted hooks still check and say to trust the plugin's again
//   no-plugin    a gated repo, and Codex without the plugin: only the repo's hooks run,
//                and the agent says how to install it. Runs first, before the install
// This repo is installed as the plugin (`codex plugin marketplace add <this repo>`),
// and hooks are trusted the way /hooks does it, through Codex's app server. Every
// gate.mjs run is logged (a NODE_OPTIONS preload). It prints one line per step,
// PASS, FAIL or BLOCKED (Codex refused to run, e.g. a usage limit), and saves
// transcripts and replies to --out. Nothing is pushed anywhere: remotes are local.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  askedQuestion,
  Blocked,
  beforeFirst,
  checkMeTurns,
  commandLine,
  explainScenario,
  gateLog,
  git,
  howSaved,
  jsonLines,
  LEARNING_CONTEXT,
  LS,
  makeDemo,
  PUSH,
  PUSH_AND_QUOTE,
  REPO,
  remoteHas,
  runScenarios,
  stepResults,
  toolEnv,
} from "./e2e-common.mjs";

const { run: RUN, model: MODEL, only: ONLY, option } = commandLine("codex");
const LOGIN = option("--login");
const CODEX =
  process.env.CODEX_BIN ?? spawnSync("/bin/sh", ["-c", "command -v codex"], { encoding: "utf8" }).stdout.trim();
if (!CODEX) throw new Error("codex isn't installed: https://learn.chatgpt.com/docs/codex/cli (or set CODEX_BIN)");
if (!LOGIN && !process.env.CODEX_API_KEY) throw new Error("pass --login <auth.json>, or set CODEX_API_KEY");

const HOME = join(RUN, "home");
const CODEX_HOME = join(RUN, "codex-home");
mkdirSync(HOME, { recursive: true });
mkdirSync(CODEX_HOME, { recursive: true });
const AUTH_COPY = join(CODEX_HOME, "auth.json");
if (LOGIN) cpSync(LOGIN, AUTH_COPY);

/** The copied sign-in goes when the run ends, whatever happened. If Codex refreshed
 *  it on the way, the original's refresh token may no longer work: say so. */
function deleteLoginCopy() {
  if (!existsSync(AUTH_COPY)) return;
  if (LOGIN && readFileSync(AUTH_COPY, "utf8") !== readFileSync(LOGIN, "utf8"))
    console.log(`\nNote: Codex refreshed the copied sign-in during the run. If ${LOGIN} stops working, sign in again.`);
  rmSync(AUTH_COPY, { force: true });
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    deleteLoginCopy();
    process.exit(130);
  });

const steps = stepResults("Codex", RUN);
const { report } = steps;
const gate = gateLog(RUN);

// ---------------------------------------------------------------- running codex

const ENV = toolEnv(RUN, gate, {
  HOME,
  CODEX_HOME,
  ...(process.env.CODEX_API_KEY ? { CODEX_API_KEY: process.env.CODEX_API_KEY } : {}),
});

/** @param {string} cwd @param {string[]} argv */
const codex = (cwd, argv) => spawnSync(CODEX, argv, { cwd, env: ENV, encoding: "utf8", input: "", timeout: 600_000 });

/** One request to Codex's app server, the API its own TUI uses.
 *  @param {string} cwd @param {{ method: string, params: object }} request */
function appServer(cwd, request) {
  const lines = [
    { method: "initialize", id: 1, params: { clientInfo: { name: "comprende-e2e", version: "1" } } },
    { method: "initialized" },
    { ...request, id: 2 },
  ];
  // The server answers, then waits for more, so stdin stays open a moment after the
  // requests. The binary's path comes through the environment, not the shell text.
  const r = spawnSync("/bin/sh", ["-c", '(cat; sleep 8) | "$CODEX_E2E_BIN" app-server'], {
    cwd,
    env: { ...ENV, CODEX_E2E_BIN: CODEX },
    encoding: "utf8",
    input: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    timeout: 60_000,
  });
  for (const line of (r.stdout ?? "").split("\n")) {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch {
      continue;
    }
    if (reply.id !== 2) continue;
    if (reply.error) throw new Error(`codex app-server ${request.method}: ${JSON.stringify(reply.error)}`);
    return reply.result;
  }
  throw new Error(`no reply from codex app-server to ${request.method}: ${r.stderr}`);
}

/**
 * Trust a project and the hooks it would run, as Codex's prompts and /hooks do.
 * @param {string} app @param {{ repoHook?: boolean }} [options] repoHook: false trusts only the plugin's
 * @returns {string[]} the trusted hooks' keys
 */
function trust(app, { repoHook = true } = {}) {
  /** @param {string} keyPath @param {object} value */
  const write = (keyPath, value) =>
    appServer(app, {
      method: "config/batchWrite",
      params: {
        edits: [{ keyPath, value, mergeStrategy: "upsert" }],
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: true,
      },
    });
  write("projects", { [app]: { trust_level: "trusted" } });
  /** @type {{ key: string, source: string, currentHash: string }[]} */
  const hooks = appServer(app, { method: "hooks/list", params: { cwds: [app] } }).data[0].hooks;
  const wanted = hooks.filter((h) => repoHook || h.source === "plugin");
  write("hooks.state", Object.fromEntries(wanted.map((h) => [h.key, { trusted_hash: h.currentHash }])));
  return wanted.map((h) => h.key);
}

/** @typedef {{ reply: string, said: string, session: string | undefined, commands: { command: string, exit: number | null }[], tools: string[] }} Turn */

/**
 * One headless Codex turn: a new session in `app`, or `resume` one. Throws Blocked
 * when Codex refuses to run it.
 * @param {string} name @param {string} app @param {string} prompt @param {{ resume?: string | undefined }} [options]
 * @returns {Turn}
 */
function turn(name, app, prompt, { resume } = {}) {
  // A reply left by an earlier run in the same --out must not pass for this one.
  for (const ext of [".reply.md", ".jsonl", ".stderr.txt"]) rmSync(join(RUN, `${name}${ext}`), { force: true });
  const lastMessage = join(RUN, `${name}.reply.md`);
  // The sandbox may write the demo, its .git (to commit) and its local remote (to
  // push). `exec resume` takes no sandbox flags, so both go through -c.
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
  const events = jsonLines(r.stdout ?? "");
  const refused = events.find(
    (e) => e.type === "error" && /usage limit|rate limit|unauthorized|log ?in/i.test(e.message ?? ""),
  );
  if (refused && !existsSync(lastMessage)) throw new Blocked(refused.message);
  const items = events.filter((e) => e.type === "item.completed").map((e) => e.item);
  return {
    reply: existsSync(lastMessage) ? readFileSync(lastMessage, "utf8") : "",
    // Everything the agent said this turn: a question can come before its last message.
    said: items
      .filter((i) => i.type === "agent_message")
      .map((i) => i.text)
      .join("\n\n"),
    session: events.find((e) => e.type === "thread.started")?.thread_id,
    commands: items
      .filter((i) => i.type === "command_execution")
      .map((i) => ({ command: i.command, exit: i.exit_code ?? null })),
    tools: items.filter((i) => i.type === "mcp_tool_call").map((i) => `${i.server}:${i.tool}`),
  };
}

// ---------------------------------------------------------------- the plugin and the demo repo

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

/** The repo's session-start runs since `from` (the plugin's pass --from-plugin). @param {number} from */
const repoSessionStarts = (from) =>
  gate.runsSince(from, ["session-start"]).filter((r) => r.argv.includes("--from-repo")).length;

/** The agents' hook runs since `from`, split by copy, and the ones that blocked.
 *  Git's pre-push hook isn't counted: each session start installs it again. @param {number} from */
function hookRuns(from) {
  const runs = gate.runsSince(from, ["agent-hook", "claude-hook"]);
  return {
    plugin: runs.filter((r) => r.argv.includes("--from-plugin")).length,
    repo: runs.filter((r) => !r.argv.includes("--from-plugin")).length,
    checks: runs.filter((r) => r.exit === 2).length,
  };
}

// ---------------------------------------------------------------- the scenarios

function main() {
  // The plugin alone: the repo's .codex/hooks.json stays untrusted here (see repoHook).
  const demo = makeDemo(RUN, "demo");
  const trusted = trust(demo.app, { repoHook: false });
  report("the plugin's two hooks are trusted", trusted.length === 2, trusted.join(", "));
  const start = turn(
    "1-session-start",
    demo.app,
    "Without running any tools: quote, word for word, the context you were given at the start of this session about Comprende and about an ownership gate. If there was none, say NONE.",
  );
  report("session start: the always-on line", /Comprende is installed/.test(start.said));
  report("session start: the gate's message", /This repository uses the ownership gate/.test(start.said));
  const session = start.session;

  const lsFrom = gate.runs().length;
  const ls = turn("2-ls", demo.app, LS, { resume: session });
  const lsRuns = hookRuns(lsFrom);
  report(
    "an ordinary command runs, and the hook is silent",
    ls.commands.some((c) => /\bls\b/.test(c.command) && c.exit === 0) && lsRuns.plugin > 0 && lsRuns.checks === 0,
    `${lsRuns.plugin} plugin hook run(s)`,
  );

  const pushFrom = gate.runs().length;
  const push = turn("3-unverified-push", demo.app, PUSH_AND_QUOTE, { resume: session });
  const pushRuns = hookRuns(pushFrom);
  report(
    "an unverified push is blocked by Codex's hook, once, and the agent sees why",
    !remoteHas(demo.remote, "feature/sum") &&
      pushRuns.checks === 1 &&
      /Ask Codex to run the ownership check/.test(push.said),
    `${pushRuns.checks} check(s)`,
  );

  const turns = checkMeTurns(
    "4",
    (name, prompt) => turn(name, demo.app, prompt, { resume: session }),
    () => remoteHas(demo.remote, "feature/sum"),
  );
  // The agent may start the check right after the blocked push, so its question can come a turn early.
  report("check me: questions asked", askedQuestion(turns[0]?.said ?? "", push.said));
  // Codex's events don't say whether an MCP call failed, so any call counts.
  const savedWith = howSaved({
    mcpTools: turns.flatMap((t) => t.tools),
    commands: turns.flatMap((t) => t.commands.filter((c) => c.exit === 0).map((c) => c.command)),
  });
  report("check me: the report saved", savedWith !== null, `with ${savedWith}`);
  report("check me: committed, then a separate push goes through", remoteHas(demo.remote, "feature/sum"));
  const trailer = git(demo.app, "log", "-1", "--format=%B").match(/^Co-authored-by: .*/m)?.[0] ?? "none";
  report("the agent's commit: its trailer", true, trailer);

  const memory = turn("5-memory", demo.app, LEARNING_CONTEXT, { resume: session });
  report(
    "the memory server: learning_context works",
    memory.tools.some((t) => /learning_context/.test(t)),
    memory.tools.join(", "),
  );
}

function explain() {
  explainScenario(RUN, steps, (app, name, prompt) => {
    trust(app);
    return turn(name, app, prompt);
  });
}

// The plugin and the repo's .codex/hooks.json, both trusted: both run, and they
// claim the push, so one checks.
function repoHook() {
  const demo = makeDemo(RUN, "demo-repo-hook");
  const keys = trust(demo.app);
  report(
    "the repo's .codex/hooks.json is trusted too: its shell hook and its session start",
    keys.filter((k) => k.includes(".codex/hooks.json")).length === 2,
    keys.join(", "),
  );
  const from = gate.runs().length;
  turn("8-repo-hook-push", demo.app, PUSH);
  const runs = hookRuns(from);
  report(
    "the plugin and the repo's hook: both run, one checks",
    runs.plugin === 1 && runs.repo === 1 && runs.checks === 1 && !remoteHas(demo.remote, "feature/sum"),
    `${runs.plugin} plugin run, ${runs.repo} repo run, ${runs.checks} check(s)`,
  );
}

// Any change to the installed plugin's files skips its hooks until they're trusted
// again. The repo's .codex/hooks.json is checked against its own command, so it still runs.
function afterUpdate() {
  const demo = makeDemo(RUN, "demo-after-update");
  trust(demo.app);
  const cache = join(CODEX_HOME, "plugins", "cache", "comprende", "comprende");
  const [version] = spawnSync("ls", [cache], { encoding: "utf8" }).stdout.trim().split("\n");
  const marker = join(cache, version, "CHANGED-BY-E2E.txt");
  writeFileSync(marker, "a change, as an update makes\n");
  try {
    const from = gate.runs().length;
    turn("9-after-update-push", demo.app, PUSH);
    const runs = hookRuns(from);
    report("after an update: Codex skips the plugin's hooks", runs.plugin === 0, `${runs.plugin} plugin hook run(s)`);
    const starts = repoSessionStarts(from);
    report("after an update: the repo's session start still runs", starts >= 1, `${starts} run(s)`);
    report(
      "after an update: the repo's trusted hook still checks the push",
      runs.repo === 1 && runs.checks === 1 && !remoteHas(demo.remote, "feature/sum"),
      `${runs.repo} repo run, ${runs.checks} check(s)`,
    );
    // The repo's session start still runs, and tells the agent the plugin's hooks were skipped.
    const t = turn(
      "10-after-update-code",
      demo.app,
      "Add a function mul(a, b) to math.js that multiplies two numbers. Don't commit.",
    );
    report("after an update: the agent says to trust the hooks again", /\/hooks/.test(t.said), "read its reply");
  } finally {
    rmSync(marker, { force: true });
  }
}

// A Codex user in a gated repo who never installed the plugin: only the repo's
// .codex/hooks.json runs. Its session start must not send them to re-trust a plugin
// they don't have.
function noPlugin() {
  const demo = makeDemo(RUN, "demo-no-plugin");
  const keys = trust(demo.app);
  // A reused --out keeps the plugin a full run installed: then this scenario can't show anything.
  if (keys.some((k) => !k.includes(".codex/hooks.json")))
    throw new Error(`the plugin is installed in ${CODEX_HOME}: run no-plugin with a fresh --out`);
  report("without the plugin: only the repo's two hooks are there to trust", keys.length === 2, keys.join(", "));
  const from = gate.runs().length;
  const t = turn(
    "11-no-plugin-code",
    demo.app,
    "Add a function mul(a, b) to math.js that multiplies two numbers. Don't commit.",
  );
  const starts = repoSessionStarts(from);
  report("without the plugin: the repo's session start runs", starts >= 1, `${starts} run(s)`);
  report(
    "without the plugin: the agent says how to install it",
    /codex plugin (marketplace )?add/.test(t.said),
    "read its reply",
  );
}

const withPlugin = beforeFirst(installPlugin);

try {
  // Inside the try, so the login copy is still deleted. no-plugin runs first, before the install.
  runScenarios(
    [
      { name: "no-plugin", run: noPlugin },
      { name: "main", run: withPlugin(main) },
      { name: "explain", run: withPlugin(explain) },
      { name: "repo-hook", run: withPlugin(repoHook) },
      { name: "after-update", run: withPlugin(afterUpdate) },
    ],
    ONLY,
    steps,
  );
} finally {
  deleteLoginCopy();
  steps.finish();
}
