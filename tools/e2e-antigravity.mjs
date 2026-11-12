// End-to-end check of Comprende in Antigravity, with the real agy CLI. Not in CI:
// it needs a signed-in agy, and it uses the account's requests. See "Testing in
// Antigravity" in CONTRIBUTING.md.
//
//   node tools/e2e-antigravity.mjs --home <folder> [--out <folder>] [--model <name>] [--only <scenario>,…]
//
// --home is a throwaway HOME where agy is signed in. The run installs this repo's
// plugin there (`agy plugin install`), in place of any copy already installed.
// Scenarios, each in its own demo repo, gated with this repo's dist/gate.mjs:
//   main     session start (the rule's instruction once, and the hook's system message:
//            the hooks run, and the gate's note), an ordinary command, an unverified
//            push, "check me" through to a push that goes through, the memory server,
//            and every hook running the installed plugin's gate.mjs
//   explain  explain-as-you-build: the skill loaded, and only the non-obvious part explained
// Both start with the install: Antigravity's own manifest, with its rule. Headless agy
// denies a tool that needs approval and has no allow rule, so each turn allows only
// what it needs (--settings). Every gate.mjs run is logged (a NODE_OPTIONS preload),
// with its path. It prints one line per step, PASS, FAIL or BLOCKED (agy reported an
// error of its own: no capacity, a timeout, the sign-in), and saves transcripts and
// replies to --out. Nothing is pushed anywhere: each demo's remote is a local folder.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  askedQuestion,
  Blocked,
  beforeFirst,
  checkMeTurns,
  commandLine,
  copyPlugin,
  explainScenario,
  gateLog,
  howSaved,
  jsonLines,
  LEARNING_CONTEXT,
  LS,
  makeDemo,
  PUSH_AND_QUOTE,
  remoteHas,
  runScenarios,
  stepResults,
  toolEnv,
} from "./e2e-common.mjs";

const { run: RUN, model: MODEL, only: ONLY, option } = commandLine("antigravity");
const HOME_OPTION = option("--home");
if (!HOME_OPTION) throw new Error("pass --home <folder>: a throwaway HOME where agy is signed in");
const HOME = realpathSync(resolve(HOME_OPTION));
const AGY = process.env.AGY_BIN ?? spawnSync("/bin/sh", ["-c", "command -v agy"], { encoding: "utf8" }).stdout.trim();
if (!AGY) throw new Error("agy isn't installed: https://antigravity.google/docs/cli (or set AGY_BIN)");

const steps = stepResults("Antigravity", RUN);
const { report } = steps;
const gate = gateLog(RUN);
const ENV = toolEnv(RUN, gate, { HOME });

/** Where `agy plugin install` puts the plugin: its hooks must run this copy's gate.mjs. */
const INSTALLED = join(HOME, ".gemini", "config", "plugins", "comprende");
/** The memory server's name in agy's allow rules and tool calls: plugin, then server. */
const MEMORY_SERVER = "comprende_comprende";
/** Reading the plugin's files (the skill) and the memory server's tool list, in `HOME`. */
const READ_AGY_FILES = `read_file(${join(HOME, ".gemini")})`;

/** A path with its symlinks resolved, or as given when it's gone. @param {string} path */
const realPath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

// ---------------------------------------------------------------- driving agy

/**
 * Runs agy, its output to `<name>.jsonl` and `<name>.stderr.txt` in the run folder.
 * Files, not pipes: agy starts a background updater, which would hold a pipe open.
 * @param {string} name @param {string} cwd @param {string[]} argv
 */
function agy(name, cwd, argv) {
  const files = [join(RUN, `${name}.jsonl`), join(RUN, `${name}.stderr.txt`)];
  const [out, err] = files.map((f) => openSync(f, "w"));
  const r = spawnSync(AGY, argv, { cwd, env: ENV, stdio: ["ignore", out, err], timeout: 660_000 });
  closeSync(out);
  closeSync(err);
  appendFileSync(files[1], `\nexit ${r.status ?? r.signal}\n`);
  const [stdout, stderr] = files.map((f) => readFileSync(f, "utf8"));
  return { status: r.status, signal: r.signal, stdout, stderr };
}

/** The error agy reported itself, on stderr: `AGY_ERROR: {"short_error", "retryable", …}`.
 *  @param {string} stderr @returns {{ short_error?: string, retryable?: boolean } | null} */
function agyError(stderr) {
  const line = /^AGY_ERROR: (.*)$/m.exec(stderr)?.[1];
  try {
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

/** @typedef {{ name: string, parameters: Record<string, unknown>, ok: boolean, error: string }} ToolStep */
/** @typedef {{ said: string, conversation: string | undefined, tools: ToolStep[], denied: string[] }} Turn */

/**
 * One headless agy turn: a new conversation, or `resume` one, with only the `allow`
 * rules its step needs. Throws Blocked when agy reports an error of its own (no
 * capacity, a timeout, the sign-in), after one more try when agy says it's worth one
 * and no tool ran yet; the first try is kept as `<name>.try-1`. Any other failure
 * throws: it may be the plugin's doing.
 * @param {string} name @param {string} app @param {string} prompt
 * @param {{ resume?: string | undefined, allow?: string[] }} [options]
 * @returns {Turn}
 */
function turn(name, app, prompt, { resume, allow = [] } = {}) {
  const argv = ["-p", prompt, "--output-format", "stream-json", "--print-timeout", "600s"];
  if (allow.length) argv.push("--settings", JSON.stringify({ permissions: { allow } }));
  if (resume) argv.push("--conversation", resume);
  if (MODEL) argv.push("--model", MODEL);
  let r = agy(name, app, argv);
  const toolRan = jsonLines(r.stdout).some((e) => e.step_update?.step_type === "tool");
  if (r.status !== 0 && agyError(r.stderr)?.retryable && !toolRan) {
    for (const ext of [".jsonl", ".stderr.txt"])
      renameSync(join(RUN, `${name}${ext}`), join(RUN, `${name}.try-1${ext}`));
    r = agy(name, app, argv);
  }
  const events = jsonLines(r.stdout);
  const result = events.find((e) => e.event === "result")?.result;
  if (r.status !== 0 || !result) {
    const reported = agyError(r.stderr);
    if (reported || r.signal) throw new Blocked(reported?.short_error ?? `agy was stopped (${r.signal})`);
    throw new Error(`agy exited ${r.status} with no reply, and no error of its own: read ${name}.stderr.txt`);
  }
  writeFileSync(join(RUN, `${name}.reply.md`), result.response ?? "");
  return {
    said: result.response ?? "",
    conversation: events.find((e) => e.event === "init")?.conversation_id,
    tools: events
      .map((e) => e.step_update)
      .filter((u) => u?.step_type === "tool" && (u.state === "DONE" || u.state === "ERROR"))
      .map((u) => ({
        name: u.tool_info?.name ?? "",
        parameters: u.tool_info?.parameters ?? {},
        ok: u.state === "DONE",
        error: u.tool_info?.error?.message ?? "",
      })),
    denied: (result.denied_actions ?? []).map((/** @type {{ action: string }} */ d) => d.action),
  };
}

/** The shell commands a turn ran (or tried) that match `pattern`. @param {Turn} t @param {RegExp} pattern */
const commands = (t, pattern) =>
  t.tools.filter((s) => s.name === "run_command" && pattern.test(String(s.parameters.CommandLine ?? "")));

/** The memory server's tools the turns called, without an error. @param {Turn[]} turns */
const memoryToolsCalled = (turns) =>
  turns
    .flatMap((t) => t.tools)
    .filter((s) => s.name === "call_mcp_tool" && s.ok && s.parameters.ServerName === MEMORY_SERVER)
    .map((s) => String(s.parameters.ToolName ?? ""));

/** A step's detail: its parts, and the tools agy denied in `turns` for want of an allow rule.
 *  @param {Turn[]} turns @param {...string} parts */
const detail = (turns, ...parts) => {
  const denied = [...new Set(turns.flatMap((t) => t.denied))];
  return [...parts, denied.length ? `agy denied ${denied.join(", ")}: no allow rule` : ""].filter(Boolean).join("; ");
};

// ---------------------------------------------------------------- the plugin

/** Installs a copy of this repo's plugin, and checks that agy took it as Antigravity's own. */
function installPlugin() {
  const copy = copyPlugin(RUN, "plugin");
  const install = agy("0-plugin-install", RUN, ["plugin", "install", copy]);
  if (install.status !== 0) throw new Error(`agy plugin install: ${install.stderr}`);
  const listed = agy("0-plugin-list", RUN, ["plugin", "list"]).stdout;
  const components = /comprende[\s\S]*?Components: *(.*)/.exec(listed)?.[1]?.trim() ?? "";
  // Without its own manifest, agy converts the Claude Code plugin: "2 hooks", and no rule.
  report(
    "install: Antigravity's own manifest, with its rule",
    components === "1 skill, 1 rule, 1 MCP server, 1 hook",
    components || "comprende isn't listed",
  );
}

// ---------------------------------------------------------------- the main scenario's steps

const HOOKS_RUN = "Comprende is installed, and its hooks run in this session.";
const GATE_NOTE = "This repository uses the ownership gate (mode: required)";
const INSTRUCTION = "Whenever you write or change code in this session";

/**
 * The instruction from the plugin's rule, once, and the hooks' session start as one
 * system message without it. Returns the conversation the next steps continue.
 * @param {string} app
 */
function sessionStart(app) {
  const from = gate.runs().length;
  const start = turn(
    "1-session-start",
    app,
    "Without running any tools: quote, word for word, every instruction or message in your context that mentions Comprende or an ownership gate, each on its own line, and say where each came from (a rule, a system message, or the user). If there are none, reply NONE.",
  );
  // What the hook sent comes from the log: the agent's quotes alone could merge two copies.
  const sent = gate.runsSince(from, ["session-start"]).map((r) => {
    try {
      return r.exit === 0 ? String(JSON.parse(r.stdout).injectSteps?.[0]?.systemMessage?.systemMessage ?? "") : "";
    } catch {
      return "";
    }
  });
  const message = sent[0] ?? "";
  report(
    "session start: the hook sends one system message, that the hooks run and the gate's note",
    sent.length === 1 && message.includes(HOOKS_RUN) && message.includes(GATE_NOTE) && !message.includes(INSTRUCTION),
    `${sent.length} session-start run(s)`,
  );
  const instructions = start.said.split(INSTRUCTION).length - 1;
  report("session start: the agent has the rule's instruction, once", instructions === 1, `${instructions} time(s)`);
  report(
    "session start: the agent has the hooks' line and the gate's note",
    start.said.includes(HOOKS_RUN) && start.said.includes(GATE_NOTE),
  );
  return start.conversation;
}

/** `ls` runs, and the hook ran on it and replied with nothing.
 *  @param {string} app @param {string | undefined} conversation */
function ordinaryCommand(app, conversation) {
  const from = gate.runs().length;
  const ls = turn("2-ls", app, LS, { resume: conversation, allow: ["command(ls)"] });
  const runs = gate.runsSince(from, ["agent-hook"]);
  report(
    "an ordinary command runs, and the hook ran and replied with nothing",
    commands(ls, /^ls$/).some((s) => s.ok) &&
      runs.length > 0 &&
      runs.every((r) => r.exit === 0 && r.stdout === "" && r.stderr === ""),
    detail([ls], `${runs.length} hook run(s)`),
  );
}

/** The hook denies the push once, with the reason, and the push never starts.
 *  @param {{ app: string, remote: string }} demo @param {string | undefined} conversation */
function unverifiedPush({ app, remote }, conversation) {
  const from = gate.runs().length;
  const push = turn("3-unverified-push", app, PUSH_AND_QUOTE, {
    resume: conversation,
    allow: ["command(git push -u origin feature/sum)"],
  });
  const denies = gate.runsSince(from, ["agent-hook"]).filter((r) => /^\{"decision":"deny"/.test(r.stdout));
  report(
    "an unverified push is denied by the hook, once, and the agent sees why",
    !remoteHas(remote, "feature/sum") &&
      denies.length === 1 &&
      commands(push, /git push/).some((s) => /denied by pre-tool hook: Blocked by the ownership gate/.test(s.error)) &&
      /Ask Antigravity to run the ownership check/.test(push.said),
    detail([push], `${denies.length} deny(ies)`),
  );
  return push;
}

/** "check me" through to a push that goes through.
 *  @param {{ app: string, remote: string }} demo @param {string | undefined} conversation @param {Turn} push */
function checkMe({ app, remote }, conversation, push) {
  // git and node for the gate's commands, ls and cat to look around, the skill's files, and the memory server.
  const allow = [
    "command(git)",
    "command(node)",
    "command(ls)",
    "command(cat)",
    READ_AGY_FILES,
    `mcp(${MEMORY_SERVER}/*)`,
  ];
  const turns = checkMeTurns(
    "4",
    (name, prompt) => turn(name, app, prompt, { resume: conversation, allow }),
    () => remoteHas(remote, "feature/sum"),
  );
  // The agent may start the check right after the blocked push, so its question can come a turn early.
  report("check me: questions asked", askedQuestion(turns[0]?.said ?? "", push.said), detail(turns));
  const savedWith = howSaved({
    mcpTools: memoryToolsCalled(turns),
    commands: turns.flatMap((t) => commands(t, /./).filter((s) => s.ok)).map((s) => String(s.parameters.CommandLine)),
  });
  report("check me: the report saved", savedWith !== null, detail(turns, `with ${savedWith}`));
  report("check me: committed, then a separate push goes through", remoteHas(remote, "feature/sum"), detail(turns));
}

/** @param {string} app @param {string | undefined} conversation */
function memoryServer(app, conversation) {
  const memory = turn("5-memory", app, LEARNING_CONTEXT, {
    resume: conversation,
    allow: [READ_AGY_FILES, `mcp(${MEMORY_SERVER}/learning_context)`],
  });
  report(
    "the memory server: learning_context works",
    memoryToolsCalled([memory]).includes("learning_context"),
    detail([memory]),
  );
}

/** Every hook run so far ran the installed plugin's gate.mjs, never a copy in the repo it
 *  looked at. The agent's own `node .learning/gate.mjs …` commands aren't hooks. */
function hooksRanTheInstalledGate() {
  const scripts = [...new Set(gate.runsSince(0, ["agent-hook", "session-start"]).map((r) => realPath(r.script)))];
  report(
    "every hook ran the installed plugin's gate.mjs",
    scripts.length === 1 && scripts[0] === realPath(join(INSTALLED, "dist", "gate.mjs")),
    scripts.join(", "),
  );
}

// ---------------------------------------------------------------- the scenarios

function main() {
  const demo = makeDemo(RUN, "demo");
  const conversation = sessionStart(demo.app);
  ordinaryCommand(demo.app, conversation);
  const push = unverifiedPush(demo, conversation);
  checkMe(demo, conversation, push);
  memoryServer(demo.app, conversation);
  hooksRanTheInstalledGate();
}

function explain() {
  const { turn: t } = explainScenario(RUN, steps, (app, name, prompt) =>
    // The skill reads its files, then calls the memory server's learning_context first.
    turn(name, app, prompt, { allow: [READ_AGY_FILES, `mcp(${MEMORY_SERVER}/*)`] }),
  );
  const skill = realPath(join(INSTALLED, "skills", "comprende", "SKILL.md"));
  report(
    "explain as you build: the skill loaded",
    existsSync(skill) &&
      t.tools.some((s) => s.name === "read_file" && s.ok && realPath(String(s.parameters.Path ?? "")) === skill),
    detail([t]),
  );
}

const withPlugin = beforeFirst(installPlugin);
try {
  runScenarios(
    [
      { name: "main", run: withPlugin(main) },
      { name: "explain", run: withPlugin(explain) },
    ],
    ONLY,
    steps,
  );
} finally {
  steps.finish();
}
