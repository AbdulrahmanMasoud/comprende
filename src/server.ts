// MCP server for Comprende.
//
// This file is deliberately thin: it describes the tools to the model and
// forwards calls to src/store/ (memory) or to the bundled gate.mjs (ownership
// check). The real logic lives there, which keeps it testable without a server.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { StoreError, resolveUserPath } from "./store/common.js";
import { EVENTS, progressReport, recordCheckpoint, recordTopic, setPreference } from "./store/profile.js";
import { addDecision, learningContext, searchDecisions, updateMap } from "./store/project.js";

const INSTRUCTIONS = `\
Memory for explaining code while building it. It remembers what the user
already knows (across all their projects) and, per project, a short map and
the reasons behind lasting decisions.

- Call learning_context once at the start of a coding session, with the
  project's absolute path, before deciding how much to explain.
- Record evidence as you notice it (record_topic), not verdicts about ability.
- Record a decision only when a new teammate would ask "why is it like this?".
- Never store secrets; the tools refuse anything that looks like one.
`;

/** A failure the model can read and fix; becomes an `isError` tool result. */
class ToolError extends Error {
  override name = "ToolError";
}

/** Run a store call, turning its refusals into tool errors the model can read and fix. */
async function call(fn: () => string): Promise<string> {
  try {
    return fn();
  } catch (e) {
    if (e instanceof StoreError) throw new ToolError(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------- the ownership gate

/** The environment for git: fixed locale and pathspecs, and core.fsmonitor
 *  forced off. fsmonitor can name a command in the repo's own .git/config, and
 *  GIT_CONFIG_* outranks every config file. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
  delete env.GIT_DIFF_OPTS;
  let n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  if (!Number.isFinite(n) || n < 0) n = 0;
  env.GIT_CONFIG_COUNT = String(n + 1);
  env[`GIT_CONFIG_KEY_${n}`] = "core.fsmonitor";
  env[`GIT_CONFIG_VALUE_${n}`] = "false";
  return env;
}

/** The top of the git working tree that contains `path` (a file or folder). */
function gateRepoRoot(path: string): string {
  let start = resolveUserPath(path || process.cwd());
  const st = fs.statSync(start, { throwIfNoEntry: false });
  if (!st) throw new ToolError(`Path does not exist: ${start}`);
  if (st.isFile()) start = dirname(start);
  const out = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, env: gitEnv() });
  if (out.error) throw out.error;
  const top = out.stdout.toString("utf8").trim();
  if (out.status !== 0 || !top) throw new ToolError(`Not inside a git working tree: ${start}`);
  return top; // git prints an absolute, normalized path
}

// The gate bundled next to this file — never a repo's own copy.
const GATE_FILE = fileURLToPath(new URL("./gate.mjs", import.meta.url));
const GATE_TIMEOUT_MS = 300_000;

interface Proc {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
}

function runProcess(argv: string[], input: string | undefined, timeoutMs: number): Promise<Proc> {
  // Nothing from the environment may load extra code into the gate.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout!.on("data", (c: Buffer) => out.push(c));
    child.stderr!.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    // After a timeout, don't wait for pipes a grandchild may still hold open.
    child.on("exit", (code) => {
      if (timedOut) finish(code);
    });
    child.on("close", (code) => finish(code));
    if (input !== undefined) {
      child.stdin!.on("error", () => {}); // the gate may exit without reading it
      child.stdin!.end(input);
    }
  });
}

/**
 * Run the bundled gate. Never the repo's own .learning/gate.*: this server
 * runs in any repo the user opens, and executing code shipped by a cloned
 * repo would be arbitrary code execution. Version differences with the
 * repo/CI copy are reported by `status` as a note.
 */
async function gateCli(repoRoot: string, args: string[], stdin?: string): Promise<string> {
  const root = gateRepoRoot(repoRoot);
  const proc = await runProcess([process.execPath, GATE_FILE, ...args, "--repo", root], stdin, GATE_TIMEOUT_MS);
  if (proc.timedOut) throw new ToolError("The gate took longer than 5 minutes.");
  const text = (b: Buffer) => b.toString("utf8").replace(/\r\n?/g, "\n").trim();
  if (proc.code !== 0) {
    const msg = text(proc.stderr);
    throw new ToolError((msg.startsWith("ownership gate: ") ? msg.slice("ownership gate: ".length) : msg) || "The gate failed.");
  }
  return text(proc.stdout);
}

const option = (name: string, value: string): string[] => (value.trim() ? [`--${name}`, value] : []);

// ---------------------------------------------------------------- tools

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const title = (name: string) =>
  name
    .split("_")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
const str = (field: string, description: string) => z.string().describe(description).meta({ title: title(field) });

const RepoRoot = str("repo_root", "Absolute path to the project's root folder.");
const Topic = str("topic", "Short concept name, e.g. 'react hooks', 'sql indexes', 'asyncio cancellation'.");
const Note = str("note", "Neutral evidence, e.g. 'asked what an image layer is'. Not a judgment.");
const Branch = (field: string) =>
  str(
    field,
    "Branch the PR will come from, if it differs from the current " +
      "local branch (e.g. pushed as another name). Empty = current branch.",
  );
const Base = (field: string) =>
  str(field, "Base ref the PR targets, e.g. 'origin/develop' or 'upstream/main' for a fork. Empty = from config / auto-detect.");

interface Tool {
  description: string;
  annotations: ToolAnnotations;
  shape: z.ZodRawShape;
  /** Validates `args` against `shape` (filling defaults), then runs the tool. */
  run: (args: unknown) => Promise<string>;
}

/** A tool whose `run` gets its arguments typed from `shape`. */
function tool<S extends z.ZodRawShape>(def: {
  description: string;
  annotations: ToolAnnotations;
  shape: S;
  run: (args: z.output<z.ZodObject<S>>) => Promise<string>;
}): Tool {
  const schema = z.object(def.shape);
  return { ...def, run: (args) => def.run(schema.parse(args)) };
}

const TOOLS: Record<string, Tool> = {
  learning_context: tool({
    description:
      "Everything needed to calibrate explanations, in one call: the learner's\n" +
      "known/learning/already-explained topics and preferences, plus this project's\n" +
      "map and decision index. Call once at the start of a session.",
    annotations: READ_ONLY,
    shape: { repo_root: str("repo_root", "Absolute project path; empty for the profile only.").default("") },
    run: (a) => call(() => learningContext(a.repo_root)),
  }),

  record_topic: tool({
    description: "Update what the learner knows about one topic. Applies across all their projects.",
    annotations: WRITES,
    shape: {
      topic: Topic,
      event: z
        .enum(EVENTS)
        .describe(
          "knows = showed they understand it; learning = showed they're new to it; " +
            "explained = you just explained it (so don't repeat it later).",
        )
        .meta({ title: "Event" }),
      note: Note.default(""),
      repo_root: str("repo_root", "Optional project path, kept as context for the note.").default(""),
    },
    run: (a) => {
      const project = a.repo_root.replace(/\/+$/, "").split("/").pop() ?? "";
      return call(() => recordTopic(a.topic, a.event, a.note, project));
    },
  }),

  record_checkpoint: tool({
    description:
      "Log the result of a checkpoint question. Two correct in a row marks the\n" +
      "topic comfortable; a wrong answer marks it learning.",
    annotations: WRITES,
    shape: {
      topic: Topic,
      question: str("question", "The quick check you asked, in one line."),
      correct: z.boolean().describe("Whether their answer showed understanding.").meta({ title: "Correct" }),
    },
    run: (a) => call(() => recordCheckpoint(a.topic, a.question, a.correct)),
  }),

  set_preference: tool({
    description:
      "Save something the user explicitly asked for about how to explain. Only\n" + "what they said, never inferred.",
    annotations: WRITES,
    shape: {
      key: str("key", "e.g. 'language', 'verbosity', 'analogies'."),
      value: str("value", "e.g. 'Egyptian Arabic', 'short'. Empty clears it."),
    },
    run: (a) => call(() => setPreference(a.key, a.value)),
  }),

  progress_report: tool({
    description:
      "Summary of the learner's progress: comfortable vs. still-learning topics,\n" +
      "recent activity, checkpoint accuracy, and what's worth revisiting. Use when\n" +
      "the user asks what they've learned.",
    annotations: READ_ONLY,
    shape: {},
    run: () => call(() => progressReport()),
  }),

  search_decisions: tool({
    description:
      "Find the project's recorded decisions relevant to what you're about to\n" +
      "change, so you explain within past reasoning instead of contradicting it.",
    annotations: READ_ONLY,
    shape: {
      repo_root: RepoRoot,
      query: str(
        "query",
        "Keywords about the area you're touching, e.g. 'cache redis invalidation'. Empty lists all.",
      ),
      limit: z.number().int().min(1).max(10).default(3).meta({ title: "Limit" }),
    },
    run: (a) => call(() => searchDecisions(a.repo_root, a.query, a.limit)),
  }),

  add_decision: tool({
    description:
      "Record a decision with lasting weight as a numbered file in\n" +
      ".learning/decisions/. Tell the user in one line when you do.",
    annotations: WRITES,
    shape: {
      repo_root: RepoRoot,
      title: str("title", "Short, e.g. 'Sliding-window rate limit in Redis'."),
      context: str("context", "The problem, in one or two lines."),
      decision: str("decision", "What was chosen."),
      alternatives: z
        .array(z.string())
        .describe("Each rejected option with why, e.g. 'fixed window — 2x bursts at edges'.")
        .meta({ title: "Alternatives" }),
      consequences: str("consequences", "What the team now has to live with."),
    },
    run: (a) =>
      call(() => addDecision(a.repo_root, a.title, a.context, a.decision, a.alternatives, a.consequences)),
  }),

  update_map: tool({
    description:
      "Replace the project map in .learning/map.md and stamp today's date.\n" +
      "Update it when structure changes or you find a new gotcha.",
    annotations: WRITES,
    shape: {
      repo_root: RepoRoot,
      content: str("content", "The full map: entry points, core modules, data flow, gotchas. Max 40 lines."),
    },
    run: (a) => call(() => updateMap(a.repo_root, a.content)),
  }),

  gate_status: tool({
    description:
      "Ownership check status of the current change: each changed file is new,\n" +
      "stale (changed since it was verified), or ok, with sensitive, ignored and\n" +
      "untracked files marked, plus the exact list that must be verified before\n" +
      "saving, and whether the change counts as small (then ask one question; the\n" +
      "summary minimum is lower). Use before the final check to know what to ask about.",
    annotations: READ_ONLY,
    shape: { repo_root: RepoRoot, base: Base("base").default(""), branch: Branch("branch").default("") },
    run: (a) => gateCli(a.repo_root, ["status", ...option("base", a.base), ...option("branch", a.branch)]),
  }),

  save_check_report: tool({
    description:
      "Save the ownership report after the final check passes. It fingerprints\n" +
      "every changed file so CI can tell if code changed afterwards. Refuses if a\n" +
      "sensitive or changed-since-last-report file isn't verified — that refusal\n" +
      "lists what is left to ask about.",
    annotations: WRITES,
    shape: {
      repo_root: RepoRoot,
      summary: str(
        "summary",
        "The developer's OWN summary of what changed, why, and what could " +
          "break — their words, not yours. Fixing typos is fine.",
      ),
      verified: z
        .record(z.string(), z.array(z.string()))
        .describe(
          "File path → concepts the developer demonstrably " +
            "understands, e.g. {'src/rateLimit.js': ['sliding-window math', " +
            "'fail-open when Redis is down']}. No scores or mistakes.",
        )
        .meta({ title: "Verified" }),
      base: Base("base").default(""),
      branch: Branch("branch").default(""),
    },
    run: (a) => {
      const payload = JSON.stringify({ summary: a.summary, verified: a.verified });
      return gateCli(a.repo_root, ["save", ...option("base", a.base), ...option("branch", a.branch)], payload);
    },
  }),
};

function buildServer(): McpServer {
  const server = new McpServer({ name: "comprende", version: "0.2.0" }, { instructions: INSTRUCTIONS });
  for (const [name, t] of Object.entries(TOOLS)) {
    server.registerTool(
      name,
      {
        description: t.description,
        inputSchema: z.object(t.shape).meta({ title: `${name}Arguments` }),
        outputSchema: z.object({ result: z.string().meta({ title: "Result" }) }).meta({ title: `${name}Output` }),
        annotations: t.annotations,
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          const text = await t.run(args);
          return { content: [{ type: "text", text }], structuredContent: { result: text } };
        } catch (e) {
          if (e instanceof ToolError) return { content: [{ type: "text", text: e.message }], isError: true };
          // A crash: the details stay in the server's log, not in the model's context.
          console.error(e);
          return { content: [{ type: "text", text: `Error executing tool ${name}` }], isError: true };
        }
      },
    );
  }
  return server;
}

async function main(argv: string[]): Promise<void> {
  // `call <tool> '<json args>'` runs one tool and prints its result — handy for
  // debugging, and how the test suite drives the server as a black box.
  if (argv.length >= 2 && argv[0] === "call") {
    const name = argv[1]!;
    const t = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
    if (t === undefined) {
      process.stderr.write(`unknown tool ${name}\n`);
      process.exitCode = 1;
      return;
    }
    let result: string;
    try {
      result = await t.run(JSON.parse(argv[2] ?? "{}"));
    } catch (e) {
      if (e instanceof ToolError) process.stderr.write(`${e.message}\n`);
      else if (e instanceof z.ZodError) process.stderr.write(`Invalid arguments for ${name}:\n${z.prettifyError(e)}\n`);
      else process.stderr.write(`${e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${result}\n`);
    return;
  }
  // stdio: the client starts this process and talks over stdin/stdout
  await buildServer().connect(new StdioServerTransport());
}

await main(process.argv.slice(2));
