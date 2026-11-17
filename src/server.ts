// MCP server for Comprende: it registers the tools in src/mcp/tools.ts, and talks
// to the client over stdio.
//
// The server is deliberately thin: its tools describe themselves to the model and
// forward calls to src/store/ (memory) or to the bundled gate.mjs (ownership check,
// src/mcp/run-gate.ts). The real logic lives there, which keeps it testable without a server.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { ToolError } from "./mcp/tool-definition.js";
import { TOOLS } from "./mcp/tools.js";

// package.json's version, set by build.mjs, so the server can't report a stale one.
declare const COMPRENDE_VERSION: string;

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

function buildServer(): McpServer {
  const server = new McpServer({ name: "comprende", version: COMPRENDE_VERSION }, { instructions: INSTRUCTIONS });
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
