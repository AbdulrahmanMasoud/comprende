// MCP server for Comprende.
//
// This file is deliberately thin: it only describes the tools to the model and
// forwards calls to store.ts. All the real logic lives there, which keeps it
// testable without running a server.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import * as store from "./store.js";

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
/** gate.py's GateError, raised by the repo-root lookup. */
class GateError extends Error {
  override name = "GateError";
}

// Turn the store's refusals into tool errors the model can read and fix.
async function call(fn: () => string | Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof store.StoreError || e instanceof GateError) throw new ToolError(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------- the ownership gate

/** gate.py `_git_env`: core.fsmonitor can name a command in the repo's own
 * .git/config; it's forced off (via GIT_CONFIG_*, which outranks every config file). */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
  delete env.GIT_DIFF_OPTS;
  const n = store.pyInt(env.GIT_CONFIG_COUNT ?? "0") ?? 0;
  env.GIT_CONFIG_COUNT = String(n + 1);
  env[`GIT_CONFIG_KEY_${n}`] = "core.fsmonitor";
  env[`GIT_CONFIG_VALUE_${n}`] = "false";
  return env;
}

/** gate.py `repo_root` */
function gateRepoRoot(path: unknown): string {
  let start = store.resolvePath(store.pyTruthy(path) ? path : process.cwd());
  if (!store.exists(start)) throw new GateError(`Path does not exist: ${start}`);
  if (store.isFile(start)) start = store.parentPath(start);
  const out = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, env: gitEnv() });
  if (out.error) throw out.error;
  const top = store.pyStrip(store.universalNewlines(out.stdout.toString("utf8")));
  if (out.status !== 0 || !top) throw new GateError(`Not inside a git working tree: ${start}`);
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
  // Like `python -I`: the interpreter ignores environment hooks that would
  // load extra code into it.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const stdinBuf = input === undefined ? undefined : store.encodeStrict(input);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: [stdinBuf === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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
    if (stdinBuf !== undefined) {
      child.stdin!.on("error", () => {}); // the gate may exit without reading it
      child.stdin!.end(stdinBuf);
    }
  });
}

/**
 * Run the bundled gate. Never the repo's own .learning/gate.*: this server
 * runs in any repo the user opens, and executing code shipped by a cloned
 * repo would be arbitrary code execution. Version differences with the
 * repo/CI copy are reported by `status` as a note.
 */
async function gateCli(repoRoot: unknown, args: string[], stdin?: string): Promise<string> {
  let root: string;
  try {
    root = gateRepoRoot(repoRoot);
  } catch (e) {
    if (e instanceof GateError) throw new ToolError(e.message);
    throw e;
  }
  const proc = await runProcess([process.execPath, GATE_FILE, ...args, "--repo", root], stdin, GATE_TIMEOUT_MS);
  if (proc.timedOut) throw new ToolError("The gate took longer than 5 minutes.");
  const text = (b: Buffer, what: string) => store.universalNewlines(store.decodeStrict(b, what));
  const stdout = text(proc.stdout, "gate's output");
  const stderr = text(proc.stderr, "gate's error output");
  if (proc.code !== 0) {
    const msg = store.pyStrip(stderr);
    throw new ToolError((msg.startsWith("ownership gate: ") ? msg.slice("ownership gate: ".length) : msg) || "The gate failed.");
  }
  return store.pyStrip(stdout);
}

function opt(name: string, value: unknown): string[] {
  return store.pyStrip(value) ? [`--${name}`, value as string] : [];
}

// ---------------------------------------------------------------- tools

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const title = (name: string) => name.split("_").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
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

/** A parameter as Python declares it: name, plus its default when it has one. */
type Param = [name: string] | [name: string, defaultValue: unknown];

interface Tool {
  description: string;
  annotations: ToolAnnotations;
  shape: z.ZodRawShape;
  params: Param[];
  fn: (...args: any[]) => Promise<string>;
}

const TOOLS: Record<string, Tool> = {
  learning_context: {
    description:
      "Everything needed to calibrate explanations, in one call: the learner's\n" +
      "known/learning/already-explained topics and preferences, plus this project's\n" +
      "map and decision index. Call once at the start of a session.",
    annotations: READ_ONLY,
    shape: { repo_root: str("repo_root", "Absolute project path; empty for the profile only.").default("") },
    params: [["repo_root", ""]],
    fn: (repoRoot) => call(() => store.learningContext(repoRoot)),
  },

  record_topic: {
    description: "Update what the learner knows about one topic. Applies across all their projects.",
    annotations: WRITES,
    shape: {
      topic: Topic,
      event: z
        .enum(["knows", "learning", "explained"])
        .describe(
          "knows = showed they understand it; learning = showed they're new to it; " +
            "explained = you just explained it (so don't repeat it later).",
        )
        .meta({ title: "Event" }),
      note: Note.default(""),
      repo_root: str("repo_root", "Optional project path, kept as context for the note.").default(""),
    },
    params: [["topic"], ["event"], ["note", ""], ["repo_root", ""]],
    fn: (topic, event, note, repoRoot) => {
      const project = store.pyTruthy(repoRoot) ? store.pyStripChars(repoRoot, "/", "right").split("/").pop()! : "";
      return call(() => store.recordTopic(topic, event, note, project));
    },
  },

  record_checkpoint: {
    description:
      "Log the result of a checkpoint question. Two correct in a row marks the\n" +
      "topic comfortable; a wrong answer marks it learning.",
    annotations: WRITES,
    shape: {
      topic: Topic,
      question: str("question", "The quick check you asked, in one line."),
      correct: z.boolean().describe("Whether their answer showed understanding.").meta({ title: "Correct" }),
    },
    params: [["topic"], ["question"], ["correct"]],
    fn: (topic, question, correct) => call(() => store.recordCheckpoint(topic, question, correct)),
  },

  set_preference: {
    description:
      "Save something the user explicitly asked for about how to explain. Only\n" + "what they said, never inferred.",
    annotations: WRITES,
    shape: {
      key: str("key", "e.g. 'language', 'verbosity', 'analogies'."),
      value: str("value", "e.g. 'Egyptian Arabic', 'short'. Empty clears it."),
    },
    params: [["key"], ["value"]],
    fn: (key, value) => call(() => store.setPreference(key, value)),
  },

  progress_report: {
    description:
      "Summary of the learner's progress: comfortable vs. still-learning topics,\n" +
      "recent activity, checkpoint accuracy, and what's worth revisiting. Use when\n" +
      "the user asks what they've learned.",
    annotations: READ_ONLY,
    shape: {},
    params: [],
    fn: () => call(() => store.progressReport()),
  },

  search_decisions: {
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
    params: [["repo_root"], ["query"], ["limit", 3]],
    fn: (repoRoot, query, limit) => call(() => store.searchDecisions(repoRoot, query, limit)),
  },

  add_decision: {
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
    params: [["repo_root"], ["title"], ["context"], ["decision"], ["alternatives"], ["consequences"]],
    fn: (repoRoot, t, context, decision, alternatives, consequences) =>
      call(() => store.addDecision(repoRoot, t, context, decision, alternatives, consequences)),
  },

  update_map: {
    description:
      "Replace the project map in .learning/map.md and stamp today's date.\n" +
      "Update it when structure changes or you find a new gotcha.",
    annotations: WRITES,
    shape: {
      repo_root: RepoRoot,
      content: str("content", "The full map: entry points, core modules, data flow, gotchas. Max 40 lines."),
    },
    params: [["repo_root"], ["content"]],
    fn: (repoRoot, content) => call(() => store.updateMap(repoRoot, content)),
  },

  gate_status: {
    description:
      "Ownership check status of the current change: each changed file is new,\n" +
      "stale (changed since it was verified), or ok, with sensitive, ignored and\n" +
      "untracked files marked, plus the exact list that must be verified before\n" +
      "saving, and whether the change counts as small (then ask one question; the\n" +
      "summary minimum is lower). Use before the final check to know what to ask about.",
    annotations: READ_ONLY,
    shape: { repo_root: RepoRoot, base: Base("base").default(""), branch: Branch("branch").default("") },
    params: [["repo_root"], ["base", ""], ["branch", ""]],
    fn: (repoRoot, base, branch) => {
      const args = ["status", ...opt("base", base), ...opt("branch", branch)];
      return gateCli(repoRoot, args);
    },
  },

  save_check_report: {
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
    params: [["repo_root"], ["summary"], ["verified"], ["base", ""], ["branch", ""]],
    fn: (repoRoot, summary, verified, base, branch) => {
      const payload = store.pyDumps({ summary, verified });
      const args = ["save", ...opt("base", base), ...opt("branch", branch)];
      return gateCli(repoRoot, args, payload);
    },
  },
};

/** Bind keyword arguments the way a Python call `fn(**kwargs)` would. */
function bind(name: string, params: Param[], kwargs: Record<string, unknown>): unknown[] {
  const names = params.map((p) => p[0]);
  for (const k of Object.keys(kwargs)) {
    if (!names.includes(k)) throw new TypeError(`${name}() got an unexpected keyword argument '${k}'`);
  }
  const missing = params.filter((p) => p.length === 1 && !Object.hasOwn(kwargs, p[0])).map((p) => `'${p[0]}'`);
  if (missing.length) {
    const list =
      missing.length === 1
        ? missing[0]
        : missing.length === 2
          ? missing.join(" and ")
          : `${missing.slice(0, -1).join(", ")}, and ${missing.at(-1)}`;
    const noun = missing.length === 1 ? "argument" : "arguments";
    throw new TypeError(`${name}() missing ${missing.length} required positional ${noun}: ${list}`);
  }
  return params.map((p) => (Object.hasOwn(kwargs, p[0]) ? kwargs[p[0]] : p[1]));
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "comprende", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  for (const [name, tool] of Object.entries(TOOLS)) {
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: z.object(tool.shape).meta({ title: `${name}Arguments` }),
        outputSchema: z.object({ result: z.string().meta({ title: "Result" }) }).meta({ title: `${name}Output` }),
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          const text = await tool.fn(...bind(name, tool.params, args));
          return { content: [{ type: "text", text }], structuredContent: { result: text } };
        } catch (e) {
          if (e instanceof ToolError) return { content: [{ type: "text", text: e.message }], isError: true };
          // A crash: like the Python SDK, the details stay in the server's log.
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
  // debugging, and how the test suite drives any implementation as a black box.
  if (argv.length >= 2 && argv[0] === "call") {
    const name = argv[1]!;
    const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
    if (tool === undefined) {
      process.stderr.write(`unknown tool ${name}\n`);
      process.exitCode = 1;
      return;
    }
    let result: string;
    try {
      const raw = store.pyLoads(argv.length > 2 ? argv[2]! : "{}");
      if (!(raw instanceof Map))
        throw new TypeError(`${name}() argument after ** must be a mapping, not ${store.pyTypeName(raw)}`);
      const kwargs = store.toPlain(raw) as Record<string, unknown>;
      result = await tool.fn(...bind(name, tool.params, kwargs));
    } catch (e) {
      if (e instanceof ToolError) process.stderr.write(`${e.message}\n`);
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
