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
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

const { run: RUN, model: MODEL, only: ONLY } = commandLine("cursor");
const AGENT = spawnSync("/bin/sh", ["-c", "command -v cursor-agent || command -v agent"], {
  encoding: "utf8",
}).stdout.trim();
if (!AGENT) throw new Error("cursor-agent isn't installed: https://cursor.com/docs/cli/installation");

const steps = stepResults("Cursor", RUN);
const { report } = steps;
const gate = gateLog(RUN);

// ---------------------------------------------------------------- the throwaway HOME and plugins

/** A copy of this repo's plugin files, as an install would have them. Without
 *  the memory server, for the run that must fall back to save --input. */
function pluginCopy(/** @type {string} */ name, { memoryServer = true } = {}) {
  const copy = join(RUN, name);
  // rules/ too: Antigravity's always-on rule sits in the same repo, and Cursor must not load it.
  for (const p of [".claude-plugin", ".cursor-plugin", "dist", "hooks", "skills", "rules", ".mcp.json"])
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

// ---------------------------------------------------------------- driving cursor-agent

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
  const env = toolEnv(RUN, gate, {
    HOME: home,
    ...(process.env.CURSOR_API_KEY ? { CURSOR_API_KEY: process.env.CURSOR_API_KEY } : {}),
  });
  const r = spawnSync(AGENT, [...argv, prompt], { cwd: workspace, env, encoding: "utf8", timeout: 600_000 });
  writeFileSync(join(RUN, `${name}.jsonl`), r.stdout ?? "");
  writeFileSync(join(RUN, `${name}.stderr.txt`), `exit ${r.status ?? r.signal}\n${r.stderr ?? ""}`);
  const refused = /ActionRequiredError: (.*)/.exec(r.stderr ?? "");
  if (refused) throw new Blocked(refused[1].trim());
  const events = jsonLines(r.stdout ?? "");
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

/**
 * "check me" through to a push that goes through (checkMeTurns), in one chat: `resume`
 * one, or the first turn starts it. Returns how the report was saved.
 * @param {string} label @param {{ app: string, remote: string }} demo @param {string} home
 * @param {{ resume?: string | undefined, plugin?: string | undefined }} options
 */
function checkMeFlow(label, { app, remote }, home, { resume, plugin }) {
  let chat = resume;
  const turns = checkMeTurns(
    label,
    (name, prompt) => {
      const turn = agent(name, app, home, prompt, { resume: chat, plugin });
      chat ??= turn.chat;
      return turn;
    },
    () => remoteHas(remote, "feature/sum"),
  );
  const succeeded = turns.flatMap((t) => t.tools).filter((c) => "success" in c.result);
  const savedWith = howSaved({
    mcpTools: succeeded.filter((c) => c.kind === "mcpToolCall").map((c) => c.args.name ?? ""),
    commands: succeeded.filter((c) => c.kind === "shellToolCall").map((c) => c.args.command ?? ""),
  });
  return { asked: /\?/.test(turns[0]?.reply ?? ""), savedWith, pushed: remoteHas(remote, "feature/sum") };
}

// ---------------------------------------------------------------- the scenarios

function main() {
  const home = makeHome("home");
  const demo = makeDemo(RUN, "demo");
  const start = agent(
    "1-session-start",
    demo.app,
    home,
    "Without running any tools: quote, word for word, every instruction or message in your context about Comprende or an ownership gate, each on its own line, and say where each came from (a rule, a hook's session start, or the user). If there was none, say NONE.",
  );
  // Once: from the session start, not also from Antigravity's rules/AGENTS.md, which Cursor
  // discovers too. Only the instruction is counted: the agent may repeat "Comprende is
  // installed" while it says where each line came from.
  report(
    "session start: the always-on line, once",
    /Comprende is installed/.test(start.reply) &&
      (start.reply.match(/Whenever you write or change code in this session/g) ?? []).length === 1,
  );
  report(
    "session start: the gate's message",
    /ownership gate/i.test(start.reply) && /mode: required/.test(start.reply),
  );
  const chat = start.chat;

  const before = gate.runs().length;
  const ls = agent("2-ls", demo.app, home, LS, { resume: chat });
  const lsRuns = gate
    .runs()
    .slice(before)
    .filter((r) => r.argv.includes("agent-hook"));
  report(
    "an ordinary command runs, and the hook is silent",
    shellCalls(ls, /^ls$/).some((t) => "success" in t.result) &&
      lsRuns.length > 0 &&
      lsRuns.every((r) => r.exit === 0 && r.stdout === "" && r.stderr === ""),
    `${lsRuns.length} hook run(s), exits ${lsRuns.map((r) => r.exit).join(",")}`,
  );

  const pushBefore = gate.runs().length;
  const push = agent("3-unverified-push", demo.app, home, `${PUSH} Quote any block message word for word.`, {
    resume: chat,
  });
  const checks = gate
    .runs()
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

  const memory = agent("5-memory", demo.app, home, LEARNING_CONTEXT, { resume: chat });
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
  const flow = checkMeFlow("6-no-memory", makeDemo(RUN, "demo-no-memory"), makeHome("home-no-memory"), { plugin });
  report("check me without the memory server: questions asked", flow.asked);
  report(
    "check me without the memory server: saved with save --input",
    flow.savedWith === "save --input",
    `with ${flow.savedWith}`,
  );
  report("check me without the memory server: a separate push goes through", flow.pushed);
}

function explain() {
  explainScenario(RUN, steps, (app, name, prompt) => ({
    said: agent(name, app, makeHome("home-explain"), prompt).reply,
  }));
}

// The Claude Code plugin imported too: each session line once, one check per push.
function bothPlugins() {
  const home = makeHome("home-both", { claudePlugin: true });
  const demo = makeDemo(RUN, "demo-both");
  const before = gate.runs().length;
  /** @type {unknown} */
  let blocked = null;
  try {
    agent("8-both-plugins", demo.app, home, PUSH);
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    blocked = e; // session start runs before the agent does, so it can still be checked
  }
  const runs = gate.runs().slice(before);
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

try {
  runScenarios(
    [
      { name: "main", run: main },
      { name: "no-memory", run: noMemory },
      { name: "explain", run: explain },
      { name: "both-plugins", run: bothPlugins },
    ],
    ONLY,
    steps,
  );
} finally {
  steps.finish();
}
