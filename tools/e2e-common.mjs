// What the end-to-end tools (tools/e2e-*.mjs) share: the command line, the step
// results, the gated demo repo, the log of every gate.mjs run, the environment an
// AI tool runs in, and the prompts and checks that are the same in every AI tool.
// Each tool adds how it drives its AI tool, and its scenarios. How to run them:
// CONTRIBUTING.md, "Testing in Cursor", "Testing in Codex" and "Testing in Antigravity".

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** This repo: the plugin under test, and the gate the demo repos install. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Reads the options every tool takes, and creates the run folder: --out (a new temp
 * folder by default), --model and --only (scenario names, comma-separated). `option`
 * reads a tool's own options.
 * @param {string} tool names the default run folder
 */
export function commandLine(tool) {
  const args = process.argv.slice(2);
  const option = (/** @type {string} */ name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const run = resolve(option("--out") ?? mkdtempSync(join(tmpdir(), `comprende-e2e-${tool}-`)));
  mkdirSync(run, { recursive: true });
  return { run, model: option("--model"), only: option("--only")?.split(","), option };
}

// ---------------------------------------------------------------- the results

/** The AI tool refused to run a turn: a usage limit, the sign-in, a model not on the plan. */
export class Blocked extends Error {}

/** @typedef {{ step: string, status: "PASS" | "FAIL" | "BLOCKED", detail?: string | undefined }} StepResult */

/**
 * One line per step, PASS, FAIL or BLOCKED, and results.json in the run folder.
 * @param {string} toolName names the tool in a BLOCKED line: "Cursor said: …" @param {string} run the run folder
 */
export function stepResults(toolName, run) {
  /** @type {StepResult[]} */
  const results = [];
  return {
    /** @param {string} step @param {boolean} ok @param {string} [detail] */
    report(step, ok, detail) {
      results.push({ step, status: ok ? "PASS" : "FAIL", detail });
      console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
    },
    /** @param {string} scenario @param {string} message */
    blocked(scenario, message) {
      results.push({ step: scenario, status: "BLOCKED", detail: message });
      console.log(`BLOCKED  ${scenario}: the rest wasn't run. ${toolName} said: ${message}`);
    },
    /** Saves results.json, and fails the process unless every step passed. */
    finish() {
      writeFileSync(join(run, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
      console.log(`\nTranscripts and replies: ${run}`);
      process.exitCode = results.every((r) => r.status === "PASS") ? 0 : 1;
    },
  };
}

/** @typedef {ReturnType<typeof stepResults>} Steps */

/**
 * Runs the scenarios --only names (all of them by default), in order. A Blocked turn
 * ends its scenario with a BLOCKED line, and the next one still runs.
 * @param {{ name: string, run: () => void }[]} scenarios @param {string[] | undefined} only @param {Steps} steps
 */
export function runScenarios(scenarios, only, steps) {
  const unknown = only?.filter((name) => !scenarios.some((s) => s.name === name)) ?? [];
  if (unknown.length) throw new Error(`no such scenario: ${unknown.join(", ")}`);
  for (const { name, run } of scenarios) {
    if (only && !only.includes(name)) continue;
    try {
      run();
    } catch (e) {
      if (!(e instanceof Blocked)) throw e;
      steps.blocked(name, e.message);
    }
  }
}

// ---------------------------------------------------------------- the gate's runs, and the AI tool's environment

/** @typedef {{ script: string, argv: string[], cwd: string, exit: number, stdout: string, stderr: string }} GateRun */

/**
 * Logs every gate.mjs run, through a NODE_OPTIONS preload: which copy ran (its path),
 * its arguments, its folder, its exit code and its output. So a step can count the
 * copies that ran and read what each replied.
 * @param {string} run the run folder
 */
export function gateLog(run) {
  const log = join(run, "gate-runs.jsonl");
  const preload = join(run, "log-gate-runs.mjs");
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";
if ((process.argv[1] ?? "").endsWith("gate.mjs")) {
  const seen = { stdout: [], stderr: [] };
  for (const stream of ["stdout", "stderr"]) {
    const write = process[stream].write.bind(process[stream]);
    process[stream].write = (c, ...r) => { seen[stream].push(String(c)); return write(c, ...r); };
  }
  process.on("exit", (code) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ script: process.argv[1], argv: process.argv.slice(2), cwd: process.cwd(), exit: code, stdout: seen.stdout.join(""), stderr: seen.stderr.join("") }) + "\\n"));
}
`,
  );
  return {
    /** The NODE_OPTIONS value that loads the preload. */
    nodeOptions: `--import=${pathToFileURL(preload).href}`,
    /** Every run so far. A line that isn't JSON throws: steps count these runs, so a
     *  lost line could pass a double check for a single one. @returns {GateRun[]} */
    runs: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  };
}

/**
 * The environment an AI tool runs in: none of yours but PATH and USER, so no personal
 * config loads; the memory server's home inside the run folder, so your memory is
 * untouched; and the gate's log. `own` adds the tool's: its HOME, a sign-in.
 * @param {string} run @param {ReturnType<typeof gateLog>} gate @param {Record<string, string>} own
 */
export const toolEnv = (run, gate, own) => ({
  PATH: process.env.PATH ?? "",
  USER: process.env.USER ?? "",
  LANG: "en_US.UTF-8",
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  COMPRENDE_HOME: join(run, "comprende-home"),
  NODE_OPTIONS: gate.nodeOptions,
  ...own,
});

/** The JSON objects in an AI tool's newline-delimited output, skipping lines that aren't JSON. @param {string} text */
export const jsonLines = (text) =>
  text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

// ---------------------------------------------------------------- the gated demo repo

/** @param {string} cwd @param {...string} a */
export const git = (cwd, ...a) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

/**
 * A repo with the gate on main (this repo's dist/gate.mjs), and an unverified `sum`
 * on feature/sum. Its remote is a folder next to it, so nothing is pushed anywhere.
 * A demo an earlier run left in the same folder is replaced.
 * @param {string} run the run folder @param {string} name
 */
export function makeDemo(run, name) {
  const dir = join(run, name);
  rmSync(dir, { recursive: true, force: true });
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
  const install = spawnSync(process.execPath, [join(REPO, "dist", "gate.mjs"), "install", "--repo", app], {
    encoding: "utf8",
  });
  if (install.status !== 0) throw new Error(`gate.mjs install: ${install.stderr}`);
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
export const remoteHas = (remote, branch) =>
  spawnSync("git", ["rev-parse", "--verify", "-q", branch], { cwd: remote }).status === 0;

// ---------------------------------------------------------------- the prompts and checks every tool shares

export const LS = "Run exactly this shell command once: `ls`. Then say what it printed.";

export const PUSH =
  "Run exactly this shell command once, and don't retry or work around it if it's blocked: `git push -u origin feature/sum`.";

export const LEARNING_CONTEXT =
  "Call the comprende memory server's learning_context tool for this project, and tell me in one line what it returned.";

const ANSWER =
  "sum totals the list with reduce. The 0 is the starting value, so an empty list gives 0 instead of throwing a TypeError. " +
  "My summary for the PR, in my own words: Added sum(xs), which adds up a list of numbers with reduce, starting from 0 so an empty list returns 0. " +
  "Please save the report now, then commit it, then push the branch as a separate command.";

const FINISH =
  "Please finish: save the report if it isn't saved, commit it, then run `git push -u origin feature/sum` as a separate command.";

/**
 * "check me" through to a push that goes through: the questions, the answer and the
 * PR summary, then up to two nudges to save, commit and push. Each turn continues the
 * same conversation.
 * @template T
 * @param {string} label the turns' file names start with it
 * @param {(name: string, prompt: string) => T} turn one turn in the conversation
 * @param {() => boolean} pushed whether the push went through
 * @returns {T[]} the turns, "check me" first
 */
export function checkMeTurns(label, turn, pushed) {
  const turns = [turn(`${label}-check-me`, "check me"), turn(`${label}-answers`, ANSWER)];
  for (let i = 0; i < 2 && !pushed(); i++) turns.push(turn(`${label}-follow-up-${i + 1}`, FINISH));
  return turns;
}

/**
 * How "check me" saved the report: the memory server's save_check_report, else the
 * gate's own `save --input` (the skill's fallback), else null.
 * @param {{ mcpTools: string[], commands: string[] }} used the MCP tools and shell commands the turns ran without an error
 */
export const howSaved = ({ mcpTools, commands }) =>
  mcpTools.some((tool) => /save_check_report/.test(tool))
    ? "the memory server's save_check_report"
    : commands.some((command) => /gate\.mjs"? save --input/.test(command))
      ? "save --input"
      : null;

const EXPLAIN =
  "Add a small function retryWithBackoff(fn, attempts) in retry.js that retries an async function, waiting with exponential backoff and full jitter between attempts. Don't commit.";

/**
 * Explain-as-you-build, in its own demo repo: the agent writes retry.js and explains
 * the non-obvious part (the jitter), briefly. Returns the turn, for a tool's own checks.
 * @template {{ said: string }} T
 * @param {string} run @param {Steps} steps
 * @param {(app: string, name: string, prompt: string) => T} ask one turn, in a new conversation in `app`
 * @returns {{ app: string, turn: T }}
 */
export function explainScenario(run, steps, ask) {
  const { app } = makeDemo(run, "demo-explain");
  git(app, "checkout", "-q", "-b", "feature/retry", "main");
  const name = "7-explain-as-you-build";
  const turn = ask(app, name, EXPLAIN);
  steps.report("explain as you build: retry.js written", existsSync(join(app, "retry.js")));
  steps.report(
    "explain as you build: a short explanation of the non-obvious part",
    /jitter/i.test(turn.said) && turn.said.length < 2500,
    `${turn.said.length} characters; read ${name}.reply.md`,
  );
  return { app, turn };
}
