// The ownership gate, run from the MCP server: always the plugin's own gate.mjs, in a
// child process with a timeout, and its failures turned into tool errors.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repoRoot } from "../gate/git.js";
import { GateError } from "../gate/shared.js";
import { ToolError } from "./tool.js";

// The gate bundled next to the server: once built, import.meta.url is dist/server.mjs.
// Never a repo's own copy.
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
export async function gateCli(path: string, args: string[], stdin?: string): Promise<string> {
  let root: string;
  try {
    root = repoRoot(path);
  } catch (e) {
    if (e instanceof GateError) throw new ToolError(e.message);
    throw e;
  }
  const proc = await runProcess([process.execPath, GATE_FILE, ...args, "--repo", root], stdin, GATE_TIMEOUT_MS);
  if (proc.timedOut) throw new ToolError("The gate took longer than 5 minutes.");
  const text = (b: Buffer) => b.toString("utf8").replace(/\r\n?/g, "\n").trim();
  if (proc.code !== 0) {
    const msg = text(proc.stderr);
    throw new ToolError(
      (msg.startsWith("ownership gate: ") ? msg.slice("ownership gate: ".length) : msg) || "The gate failed.",
    );
  }
  return text(proc.stdout);
}

export const option = (name: string, value: string): string[] => (value.trim() ? [`--${name}`, value] : []);
