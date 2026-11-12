// End-to-end check of Comprende in Antigravity, with the real agy CLI. Not in CI:
// it needs a signed-in agy, and it uses the account's requests. See "Testing in
// Antigravity" in CONTRIBUTING.md.
//
//   node tools/e2e-antigravity.mjs --home <folder> [--out <folder>] [--model <name>] [--only <scenario>,…]
//
// --home is a throwaway HOME where agy is signed in. The run installs this repo's
// plugin there (`agy plugin install`), in place of any copy already installed.
// Scenarios, each in its own demo repo, gated with this repo's dist/gate.mjs:
//   main     the plugin's install, session start (the rule's instruction once, the line
//            that says the hooks ran, the gate's note), an ordinary command, an
//            unverified push, "check me" through to a push that goes through, and the
//            memory server
//   explain  explain-as-you-build: the skill loaded, and only the non-obvious part explained
// Headless agy denies any tool that has no allow rule, so each turn allows only what
// it needs (--settings). Every gate.mjs run is logged (a NODE_OPTIONS preload), with
// its path: the hooks must run the installed plugin's copy, never the repo's. It
// prints one line per step, PASS, FAIL or BLOCKED (agy gave no reply: a usage limit,
// a timeout, the sign-in), and saves transcripts and replies to --out. Nothing is
// pushed anywhere: each demo's remote is a local folder.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  cpSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  Blocked,
  checkMeTurns,
  commandLine,
  explainScenario,
  gateLog,
  howSaved,
  jsonLines,
  LEARNING_CONTEXT,
  LS,
  makeDemo,
  PUSH,
  REPO,
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

/** Where `agy plugin install` puts the plugin: its hooks must run this copy's gate.mjs. */
const INSTALLED = join(HOME, ".gemini", "config", "plugins", "comprende");
/** The memory server's name in agy's allow rules: plugin name, then server name. */
const MEMORY = "comprende_comprende";

const ENV = toolEnv(RUN, gate, { HOME });

/** A path with its symlinks resolved, or as given when it's gone. @param {string} path */
const realPath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

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
  return { status: r.status, stdout, stderr };
}

// ---------------------------------------------------------------- the plugin

/** This repo's plugin files, copied as GitHub would serve them, then installed. */
function installPlugin() {
  const copy = join(RUN, "plugin");
  rmSync(copy, { recursive: true, force: true });
  // The other tools' manifests too: with .antigravity-plugin/ there, agy must ignore them.
  for (const p of [
    ".antigravity-plugin",
    ".claude-plugin",
    ".codex-plugin",
    ".cursor-plugin",
    ".mcp.json",
    "dist",
    "hooks",
    "hooks.json",
    "mcp_config.json",
    "rules",
    "skills",
  ])
    cpSync(join(REPO, p), join(copy, p), { recursive: true });
  const install = agy("0-plugin-install", RUN, ["plugin", "install", copy]);
  if (install.status !== 0) throw new Error(`agy plugin install: ${install.stderr}`);
  const list = agy("0-plugin-list", RUN, ["plugin", "list"]);
  return /comprende[\s\S]*?Components: *(.*)/.exec(list.stdout)?.[1]?.trim() ?? "";
}

let pluginInstalled = false;
/** Wraps a scenario that needs the plugin: the first one installs it and reports what agy
 *  found, and it stays. */
const withPlugin = (/** @type {() => void} */ run) => () => {
  if (!pluginInstalled) {
    const components = installPlugin();
    report(
      "install: Antigravity's own manifest, with its rule",
      components === "1 skill, 1 rule, 1 MCP server, 1 hook",
      components || "comprende isn't listed",
    );
    pluginInstalled = true;
  }
  run();
};

// ---------------------------------------------------------------- driving agy

/** @typedef {{ name: string, parameters: Record<string, unknown>, ok: boolean, error: string }} ToolStep */
/** @typedef {{ said: string, conversation: string | undefined, tools: ToolStep[], denied: string[] }} Turn */

/**
 * One headless agy turn: a new conversation, or `resume` one. `allow` lists the allow
 * rules this turn needs. Throws Blocked when agy gives no reply (a usage limit, a
 * timeout, the sign-in). A turn that failed before any tool ran is tried once more:
 * agy sometimes fails on a busy server.
 * @param {string} name @param {string} app @param {string} prompt
 * @param {{ resume?: string | undefined, allow?: string[] }} [options]
 * @returns {Turn}
 */
function turn(name, app, prompt, { resume, allow = [] } = {}) {
  const argv = ["-p", prompt, "--output-format", "stream-json", "--print-timeout", "600s"];
  if (allow.length) argv.push("--settings", JSON.stringify({ permissions: { allow } }));
  if (resume) argv.push("--conversation", resume);
  if (MODEL) argv.push("--model", MODEL);
  const toolRan = (/** @type {string} */ stdout) => jsonLines(stdout).some((e) => e.step_update?.step_type === "tool");
  let r = agy(name, app, argv);
  if (r.status !== 0 && !toolRan(r.stdout)) r = agy(name, app, argv);
  const events = jsonLines(r.stdout);
  const result = events.find((e) => e.event === "result")?.result;
  if (r.status !== 0 || !result) throw new Blocked(r.stderr.trim().split("\n")[0] || `agy exited ${r.status}`);
  const tools = events
    .map((e) => e.step_update)
    .filter((u) => u?.step_type === "tool" && (u.state === "DONE" || u.state === "ERROR"))
    .map((u) => ({
      name: u.tool_info?.name ?? "",
      parameters: u.tool_info?.parameters ?? {},
      ok: u.state === "DONE",
      error: u.tool_info?.error?.message ?? "",
    }));
  writeFileSync(join(RUN, `${name}.reply.md`), result.response ?? "");
  return {
    said: result.response ?? "",
    conversation: events.find((e) => e.event === "init")?.conversation_id,
    tools,
    denied: (result.denied_actions ?? []).map((/** @type {{ action: string }} */ d) => d.action),
  };
}

/** @param {Turn} t @param {RegExp} command */
const commands = (t, command) =>
  t.tools.filter((s) => s.name === "run_command" && command.test(String(s.parameters.CommandLine ?? "")));

/** @param {Turn} t @param {string} tool */
const memoryCalls = (t, tool) =>
  t.tools.filter(
    (s) => s.name === "call_mcp_tool" && s.parameters.ServerName === MEMORY && s.parameters.ToolName === tool && s.ok,
  );

/** A step's detail: its parts, and the tools agy denied in `turns` for want of an allow rule.
 *  @param {Turn[]} turns @param {...string} parts */
const detail = (turns, ...parts) => {
  const denied = [...new Set(turns.flatMap((t) => t.denied))];
  return [...parts, denied.length ? `agy denied ${denied.join(", ")}: no allow rule` : ""].filter(Boolean).join("; ");
};

/** The agents' hook runs since `from`, and their replies. @param {number} from */
const hookRuns = (from) =>
  gate
    .runs()
    .slice(from)
    .filter((r) => r.argv.includes("agent-hook"));

// ---------------------------------------------------------------- the scenarios

/** The allow rules for "check me": git and node for the gate's commands, the plugin's
 *  files and the memory server's tool list to read, and the memory server. */
const CHECK_ME_ALLOW = [
  "command(git)",
  "command(node)",
  "command(ls)",
  "command(cat)",
  `read_file(${join(HOME, ".gemini")})`,
  `mcp(${MEMORY}/*)`,
];

function main() {
  const demo = makeDemo(RUN, "demo");
  const startFrom = gate.runs().length;
  const start = turn(
    "1-session-start",
    demo.app,
    "Without running any tools: quote, word for word, every instruction or message in your context that mentions Comprende or an ownership gate, each on its own line, and say where each came from (a rule, a system message, or the user). If there are none, reply NONE.",
  );
  // The instruction comes from the plugin's rules/AGENTS.md, and only there: the session
  // start from the plugin's own hooks says only that they ran.
  const instructions = (start.said.match(/Whenever you write or change code in this session/g) ?? []).length;
  report("session start: the rule's instruction, once", instructions === 1, `${instructions} time(s)`);
  report(
    "session start: the line that says the hooks run",
    /Comprende is installed, and its hooks run in this session/.test(start.said),
  );
  report("session start: the gate's note", /ownership gate/i.test(start.said) && /mode: required/.test(start.said));
  const starts = gate
    .runs()
    .slice(startFrom)
    .filter((r) => r.argv.includes("session-start"));
  report(
    "session start: the reply is Antigravity's system message",
    starts.length > 0 && starts.every((r) => r.exit === 0 && /^\{"injectSteps":\[\{"systemMessage"/.test(r.stdout)),
    `${starts.length} run(s)`,
  );
  const conversation = start.conversation;

  const lsFrom = gate.runs().length;
  const ls = turn("2-ls", demo.app, LS, { resume: conversation, allow: ["command(ls)"] });
  const lsRuns = hookRuns(lsFrom);
  report(
    "an ordinary command runs, and the hook ran and replied with nothing",
    commands(ls, /^ls$/).some((s) => s.ok) &&
      lsRuns.length > 0 &&
      lsRuns.every((r) => r.exit === 0 && r.stdout === "" && r.stderr === ""),
    detail([ls], `${lsRuns.length} hook run(s)`),
  );

  const pushFrom = gate.runs().length;
  const push = turn("3-unverified-push", demo.app, `${PUSH} Quote any block message word for word.`, {
    resume: conversation,
    allow: ["command(git push -u origin feature/sum)"],
  });
  const denies = hookRuns(pushFrom).filter((r) => /^\{"decision":"deny"/.test(r.stdout));
  report(
    "an unverified push is denied by the hook, once, and the agent sees why",
    !remoteHas(demo.remote, "feature/sum") &&
      denies.length === 1 &&
      commands(push, /git push/).some((s) => /denied by pre-tool hook: Blocked by the ownership gate/.test(s.error)) &&
      /Ask Antigravity to run the ownership check/.test(push.said),
    detail([push], `${denies.length} deny(ies)`),
  );

  const turns = checkMeTurns(
    "4",
    (name, prompt) => turn(name, demo.app, prompt, { resume: conversation, allow: CHECK_ME_ALLOW }),
    () => remoteHas(demo.remote, "feature/sum"),
  );
  // The agent may start the check right after the blocked push, so its question can come a turn early.
  report("check me: questions asked", /[?؟]/.test(turns[0]?.said ?? "") || /[?؟]/.test(push.said), detail(turns));
  const succeeded = turns.flatMap((t) => t.tools).filter((s) => s.ok);
  const savedWith = howSaved({
    mcpTools: succeeded
      .filter((s) => s.name === "call_mcp_tool" && s.parameters.ServerName === MEMORY)
      .map((s) => String(s.parameters.ToolName ?? "")),
    commands: succeeded.filter((s) => s.name === "run_command").map((s) => String(s.parameters.CommandLine ?? "")),
  });
  report("check me: the report saved", savedWith !== null, detail(turns, `with ${savedWith}`));
  report(
    "check me: committed, then a separate push goes through",
    remoteHas(demo.remote, "feature/sum"),
    detail(turns),
  );

  const memory = turn("5-memory", demo.app, LEARNING_CONTEXT, {
    resume: conversation,
    allow: [`read_file(${join(HOME, ".gemini")})`, `mcp(${MEMORY}/learning_context)`],
  });
  report(
    "the memory server: learning_context works",
    memoryCalls(memory, "learning_context").length > 0,
    detail([memory]),
  );

  // Every hook ran the installed plugin's gate.mjs, never a copy in the repo it looked at.
  // The agent's own commands, such as `node .learning/gate.mjs status`, don't count.
  const scripts = [
    ...new Set(
      gate
        .runs()
        .filter((r) => r.argv.includes("--from-plugin"))
        .map((r) => realPath(r.script)),
    ),
  ];
  report(
    "every hook ran the installed plugin's gate.mjs",
    scripts.length === 1 && scripts[0] === realPath(join(INSTALLED, "dist", "gate.mjs")),
    scripts.join(", "),
  );
}

function explain() {
  const { turn: t } = explainScenario(RUN, steps, (app, name, prompt) =>
    // The skill reads its files, then calls the memory server's learning_context first.
    turn(name, app, prompt, { allow: [`read_file(${join(HOME, ".gemini")})`, `mcp(${MEMORY}/*)`] }),
  );
  const skill = realPath(join(INSTALLED, "skills", "comprende", "SKILL.md"));
  report(
    "explain as you build: the skill loaded",
    t.tools.some((s) => s.name === "read_file" && s.ok && realPath(String(s.parameters.Path ?? "")) === skill),
    detail([t]),
  );
}

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
