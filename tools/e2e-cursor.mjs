// End-to-end check of Comprende in Cursor, with the real cursor-agent. Not in CI:
// it needs a logged-in Cursor CLI, and it uses the account's agent requests.
// See "Testing in Cursor" in CONTRIBUTING.md.
//
//   node tools/e2e-cursor.mjs [--out <folder>] [--model <name>] [--only <scenario>,…]
//
// Scenarios, each in its own demo repo, gated with this repo's dist/gate.mjs:
//   main          session start, an ordinary command, an unverified push, "check me"
//                 through to a push that goes through, and the memory server
//   no-memory     "check me" without the memory server: the report saved with save --input
//   explain       explain-as-you-build: only the non-obvious part explained
//   both-plugins  the Claude Code plugin imported as well: each session line once,
//                 and one check per push
// This repo is the Cursor plugin (--plugin-dir). Every gate.mjs run is logged (a
// NODE_OPTIONS preload), so a step can count the copies that ran. It prints one
// line per step, PASS, FAIL or BLOCKED (Cursor refused to run the agent, for
// example at the account's usage limit), and saves transcripts and replies to --out.
//
// Isolation: a throwaway HOME, so no personal config or plugins load, and
// COMPRENDE_HOME in the run folder, so your memory is untouched. On macOS the
// login lives in the keychain, which the throwaway HOME links to; elsewhere set
// CURSOR_API_KEY. Nothing is pushed anywhere: each demo's remote is a local folder.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (/** @type {string} */ name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const RUN = resolve(opt("--out") ?? mkdtempSync(join(tmpdir(), "comprende-e2e-cursor-")));
const MODEL = opt("--model");
const ONLY = opt("--only")?.split(",");
const AGENT = spawnSync("/bin/sh", ["-c", "command -v cursor-agent || command -v agent"], {
  encoding: "utf8",
}).stdout.trim();
if (!AGENT) throw new Error("cursor-agent isn't installed: https://cursor.com/docs/cli/installation");

mkdirSync(RUN, { recursive: true });
/** @type {{ step: string, status: "PASS" | "FAIL" | "BLOCKED", detail?: string | undefined }[]} */
const results = [];
/** @param {string} step @param {boolean} ok @param {string} [detail] */
const report = (step, ok, detail) => {
  results.push({ step, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
};

/** Cursor refused to run the agent: the account's usage limit, a model not on its plan. */
class Blocked extends Error {}

// ---------------------------------------------------------------- the throwaway HOME and plugins

/** A copy of this repo's plugin files, as an install would have them. Without
 *  the memory server, for the run that must fall back to save --input. */
function pluginCopy(/** @type {string} */ name, { memoryServer = true } = {}) {
  const copy = join(RUN, name);
  for (const p of [".claude-plugin", ".cursor-plugin", "dist", "hooks", "skills", ".mcp.json"])
    cpSync(join(REPO, p), join(copy, p), { recursive: true });
  if (!memoryServer) {
    const manifest = join(copy, ".cursor-plugin", "plugin.json");
    const { mcpServers: _, ...rest } = JSON.parse(readFileSync(manifest, "utf8"));
    writeFileSync(manifest, JSON.stringify(rest, null, 2));
    writeFileSync(join(copy, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  }
  return copy;
}

/** @param {string} name @param {{ claudePlugin?: boolean }} [options] */
function makeHome(name, { claudePlugin = false } = {}) {
  const home = join(RUN, name);
  mkdirSync(join(home, ".cursor"), { recursive: true });
  const config = join(homedir(), ".cursor", "cli-config.json");
  if (existsSync(config)) cpSync(config, join(home, ".cursor", "cli-config.json"));
  if (process.platform === "darwin" && !existsSync(join(home, "Library"))) {
    mkdirSync(join(home, "Library"));
    symlinkSync(join(homedir(), "Library", "Keychains"), join(home, "Library", "Keychains"));
  }
  if (claudePlugin) {
    // As if Comprende were installed in Claude Code too: Cursor imports it.
    const copy = pluginCopy("claude-plugin");
    const plugins = join(home, ".claude", "plugins");
    mkdirSync(plugins, { recursive: true });
    const version = JSON.parse(readFileSync(join(REPO, ".claude-plugin", "plugin.json"), "utf8")).version;
    writeFileSync(
      join(plugins, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "comprende@comprende": [{ scope: "user", installPath: copy, version }] },
      }),
    );
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "comprende@comprende": true } }),
    );
  }
  return home;
}

// ---------------------------------------------------------------- the gated demo repo

/** @param {string} cwd @param {...string} a */
const git = (cwd, ...a) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

/** A repo with the gate on main, and an unverified `sum` on feature/sum. */
function makeDemo(/** @type {string} */ name) {
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

// ---------------------------------------------------------------- driving cursor-agent

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

/** @typedef {{ kind: string, args: { command?: string, name?: string }, result: Record<string, unknown> }} ToolCall */
/** @typedef {{ reply: string, chat: string | undefined, tools: ToolCall[] }} Turn */

/**
 * One headless cursor-agent turn: a new chat, or `resume` one. Throws Blocked
 * when Cursor refuses to run it.
 * @param {string} name @param {string} workspace @param {string} home @param {string} prompt
 * @param {{ resume?: string | undefined, plugin?: string | undefined }} [options] plugin: the plugin folder to load
 * @returns {Turn}
 */
function agent(name, workspace, home, prompt, { resume, plugin = REPO } = {}) {
  const argv = ["-p", "--output-format", "stream-json", "--trust", "--force", "--approve-mcps"];
  argv.push("--plugin-dir", plugin, "--workspace", workspace);
  if (resume) argv.push("--resume", resume);
  if (MODEL) argv.push("--model", MODEL);
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    USER: process.env.USER ?? "",
    LANG: "en_US.UTF-8",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    COMPRENDE_HOME: join(RUN, "comprende-home"),
    NODE_OPTIONS: `--import=${pathToFileURL(PRELOAD).href}`,
    ...(process.env.CURSOR_API_KEY ? { CURSOR_API_KEY: process.env.CURSOR_API_KEY } : {}),
  };
  const r = spawnSync(AGENT, [...argv, prompt], { cwd: workspace, env, encoding: "utf8", timeout: 600_000 });
  writeFileSync(join(RUN, `${name}.jsonl`), r.stdout ?? "");
  writeFileSync(join(RUN, `${name}.stderr.txt`), `exit ${r.status ?? r.signal}\n${r.stderr ?? ""}`);
  const refused = /ActionRequiredError: (.*)/.exec(r.stderr ?? "");
  if (refused) throw new Blocked(refused[1].trim());
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
  const result = events.find((e) => e.type === "result");
  const tools = events
    .filter((e) => e.type === "tool_call" && e.subtype === "completed")
    .map((e) => {
      const [kind, call] = Object.entries(e.tool_call ?? {})[0] ?? ["", {}];
      return { kind, args: call.args ?? {}, result: call.result ?? {} };
    });
  writeFileSync(join(RUN, `${name}.reply.md`), result?.result ?? "");
  return { reply: result?.result ?? "", chat: result?.session_id, tools };
}

/** @param {Turn} turn @param {RegExp} re */
const shellCalls = (turn, re) => turn.tools.filter((t) => t.kind === "shellToolCall" && re.test(t.args.command ?? ""));

const PUSH =
  "Run exactly this shell command once, and don't retry or work around it if it's blocked: `git push -u origin feature/sum`.";

const ANSWER =
  "sum totals the list with reduce. The 0 is the starting value, so an empty list gives 0 instead of throwing a TypeError. " +
  "My summary for the PR, in my own words: Added sum(xs), which adds up a list of numbers with reduce, starting from 0 so an empty list returns 0. " +
  "Please save the report now, then commit it, then push the branch as a separate command.";

/**
 * "check me" through to a push that goes through: the questions, the answer and
 * summary, the save, the commit, then the push. Returns how the report was saved.
 * @param {string} label @param {{ app: string, remote: string }} demo @param {string} home
 * @param {{ resume?: string | undefined, plugin?: string | undefined }} options
 */
function checkMeFlow(label, { app, remote }, home, { resume, plugin }) {
  const asked = agent(`${label}-check-me`, app, home, "check me", { resume, plugin });
  const chat = resume ?? asked.chat;
  const turns = [asked, agent(`${label}-answers`, app, home, ANSWER, { resume: chat, plugin })];
  for (let i = 0; i < 2 && !remoteHas(remote, "feature/sum"); i++) {
    turns.push(
      agent(
        `${label}-follow-up-${i + 1}`,
        app,
        home,
        "Please finish: save the report if it isn't saved, commit it, then run `git push -u origin feature/sum` as a separate command.",
        { resume: chat, plugin },
      ),
    );
  }
  const used = (/** @type {(t: ToolCall) => boolean} */ match) =>
    turns.some((t) => t.tools.some((c) => match(c) && "success" in c.result));
  const savedWith = used((c) => c.kind === "mcpToolCall" && /save_check_report/.test(c.args.name ?? ""))
    ? "the memory server's save_check_report"
    : used((c) => c.kind === "shellToolCall" && /gate\.mjs"? save --input/.test(c.args.command ?? ""))
      ? "save --input"
      : null;
  return { asked: /\?/.test(asked.reply), savedWith, pushed: remoteHas(remote, "feature/sum") };
}

// ---------------------------------------------------------------- the scenarios

function main() {
  const home = makeHome("home");
  const demo = makeDemo("demo");
  const start = agent(
    "1-session-start",
    demo.app,
    home,
    "Without running any tools: quote, word for word, the context you were given at the start of this session about Comprende and about an ownership gate. If there was none, say NONE.",
  );
  report("session start: the always-on line", /Comprende is installed/.test(start.reply));
  report(
    "session start: the gate's message",
    /ownership gate/i.test(start.reply) && /mode: required/.test(start.reply),
  );
  const chat = start.chat;

  const before = gateRuns().length;
  const ls = agent("2-ls", demo.app, home, "Run exactly this shell command once: `ls`. Then say what it printed.", {
    resume: chat,
  });
  const lsRuns = gateRuns()
    .slice(before)
    .filter((r) => r.argv.includes("agent-hook"));
  report(
    "an ordinary command runs, and the hook is silent",
    shellCalls(ls, /^ls$/).some((t) => "success" in t.result) &&
      lsRuns.length > 0 &&
      lsRuns.every((r) => r.exit === 0 && r.stdout === "" && r.stderr === ""),
    `${lsRuns.length} hook run(s), exits ${lsRuns.map((r) => r.exit).join(",")}`,
  );

  const pushBefore = gateRuns().length;
  const push = agent("3-unverified-push", demo.app, home, `${PUSH} Quote any block message word for word.`, {
    resume: chat,
  });
  const checks = gateRuns()
    .slice(pushBefore)
    .filter((r) => r.exit === 2);
  report(
    "an unverified push is blocked, and the agent sees why",
    !remoteHas(demo.remote, "feature/sum") && /Blocked by the ownership gate/.test(push.reply) && checks.length === 1,
    `${checks.length} copy(ies) checked`,
  );

  const flow = checkMeFlow("4", demo, home, { resume: chat });
  report("check me: questions asked", flow.asked);
  report("check me: the report saved", flow.savedWith !== null, `with ${flow.savedWith}`);
  report("check me: committed, then a separate push goes through", flow.pushed);

  const memory = agent(
    "5-memory",
    demo.app,
    home,
    "Call the comprende memory server's learning_context tool for this project, and tell me in one line what it returned.",
    { resume: chat },
  );
  report(
    "the memory server: learning_context works",
    memory.tools.some(
      (t) => t.kind === "mcpToolCall" && /learning_context/.test(t.args.name ?? "") && "success" in t.result,
    ),
  );
}

// Without the memory server, the skill falls back to the gate's save --input.
function noMemory() {
  const plugin = pluginCopy("plugin-no-memory", { memoryServer: false });
  const flow = checkMeFlow("6-no-memory", makeDemo("demo-no-memory"), makeHome("home-no-memory"), { plugin });
  report("check me without the memory server: questions asked", flow.asked);
  report(
    "check me without the memory server: saved with save --input",
    flow.savedWith === "save --input",
    `with ${flow.savedWith}`,
  );
  report("check me without the memory server: a separate push goes through", flow.pushed);
}

function explain() {
  const { app } = makeDemo("demo-explain");
  git(app, "checkout", "-q", "-b", "feature/retry", "main");
  const turn = agent(
    "7-explain-as-you-build",
    app,
    makeHome("home-explain"),
    "Add a small function retryWithBackoff(fn, attempts) in retry.js that retries an async function, waiting with exponential backoff and full jitter between attempts. Don't commit.",
  );
  report("explain as you build: retry.js written", existsSync(join(app, "retry.js")));
  report(
    "explain as you build: a short explanation of the non-obvious part",
    /jitter/i.test(turn.reply) && turn.reply.length < 2500,
    `${turn.reply.length} characters; read 7-explain-as-you-build.reply.md`,
  );
}

// The Claude Code plugin imported too: each session line once, one check per push.
function bothPlugins() {
  const home = makeHome("home-both", { claudePlugin: true });
  const demo = makeDemo("demo-both");
  const before = gateRuns().length;
  /** @type {unknown} */
  let blocked = null;
  try {
    agent("8-both-plugins", demo.app, home, PUSH);
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    blocked = e; // session start runs before the agent does, so it can still be checked
  }
  const runs = gateRuns().slice(before);
  const contexts = runs
    .filter((r) => r.argv.includes("session-start"))
    .map((r) => {
      try {
        return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? "";
      } catch {
        return "";
      }
    });
  const count = (/** @type {RegExp} */ re) => contexts.filter((c) => re.test(c)).length;
  report(
    "both plugins: each session line once",
    count(/Comprende is installed/) === 1 && count(/This repository uses the ownership gate/) === 1,
    `${contexts.length} session-start run(s): always-on ${count(/Comprende is installed/)}, gate ${count(/This repository uses the ownership gate/)}`,
  );
  if (blocked) throw blocked;
  const checks = runs.filter((r) => r.exit === 2).length;
  report(
    "both plugins: one check per push",
    checks === 1 && !remoteHas(demo.remote, "feature/sum"),
    `${checks} check(s)`,
  );
}

const SCENARIOS = { main, "no-memory": noMemory, explain, "both-plugins": bothPlugins };
for (const [name, run] of Object.entries(SCENARIOS)) {
  if (ONLY && !ONLY.includes(name)) continue;
  try {
    run();
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    results.push({ step: name, status: "BLOCKED", detail: e.message });
    console.log(`BLOCKED  ${name}: the rest wasn't run. Cursor said: ${e.message}`);
  }
}

writeFileSync(join(RUN, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(`\nTranscripts and replies: ${RUN}`);
process.exitCode = results.every((r) => r.status === "PASS") ? 0 : 1;
