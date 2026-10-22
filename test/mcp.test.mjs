// The MCP server end to end: a real stdio session, and the gate tools it exposes.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callTool, ENV, git, NODE, REPO_GATE, SERVER, setup, tmp, write } from "./helpers.mjs";

/** Node version of impl.code_version_stub / code_write_marker. */
const codeVersionStub = (version, marker) =>
  `// ownership-gate-version: ${version}\n` +
  `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'x');\n`;

const EXPECTED_TOOLS = new Set([
  "learning_context",
  "record_topic",
  "record_checkpoint",
  "set_preference",
  "progress_report",
  "search_decisions",
  "add_decision",
  "update_map",
  "gate_status",
  "save_check_report",
]);

const textOf = (result) => result.content.map((c) => c.text ?? "").join("");

async function sessionFlow(home, repo) {
  const transport = new StdioClientTransport({
    command: NODE,
    args: [SERVER],
    env: { ...ENV, COMPRENDE_HOME: home },
  });
  const session = new Client({ name: "e2e-test", version: "0.0.0" });
  await session.connect(transport); // connect() runs the initialize handshake
  try {
    assert.ok((session.getInstructions() ?? "").includes("learning_context"));

    const tools = Object.fromEntries((await session.listTools()).tools.map((t) => [t.name, t]));
    assert.deepEqual(new Set(Object.keys(tools)), EXPECTED_TOOLS);
    assert.equal(tools.learning_context.annotations?.readOnlyHint, true);
    assert.ok(JSON.stringify(tools.record_topic.inputSchema).includes("Neutral evidence"));

    await session.callTool({
      name: "record_topic",
      arguments: {
        topic: "asyncio",
        event: "learning",
        note: "new to event loops",
        repo_root: repo,
      },
    });
    await session.callTool({
      name: "add_decision",
      arguments: {
        repo_root: repo,
        title: "Semaphore for concurrency cap",
        context: "too many sockets",
        decision: "asyncio.Semaphore(10)",
        alternatives: ["connector limit — hides intent"],
        consequences: "none",
      },
    });
    const ctx = textOf(await session.callTool({ name: "learning_context", arguments: { repo_root: repo } }));
    assert.ok(ctx.includes("asyncio") && ctx.includes("0001 — Semaphore for concurrency cap"));

    const bad = await session.callTool({
      name: "record_topic",
      arguments: {
        topic: "x",
        event: "learning",
        note: "token = ghp_" + "a".repeat(36),
      },
    });
    assert.ok(bad.isError === true && textOf(bad).includes("credential"));

    const invalid = await session.callTool({ name: "record_topic", arguments: { topic: "x", event: "mastered" } });
    assert.equal(invalid.isError, true);

    // Ownership gate through MCP, on a real git repo
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "app.py"), "x = 1\n");
    git(repo, "add", "app.py");
    git(repo, "commit", "-qm", "init");
    git(repo, "checkout", "-q", "-b", "feat");
    writeFileSync(join(repo, "app.py"), "x = 2\n");
    const st = textOf(await session.callTool({ name: "gate_status", arguments: { repo_root: repo } }));
    assert.ok(st.includes("app.py [new]"));
    const short = await session.callTool({
      name: "save_check_report",
      arguments: {
        repo_root: repo,
        summary: "changed x",
        verified: { "app.py": ["why x is 2"] },
      },
    });
    assert.ok(short.isError === true && textOf(short).includes("summary"));
    const ok = await session.callTool({
      name: "save_check_report",
      arguments: {
        repo_root: repo,
        summary:
          "Bumped x to 2 because the downstream parser expects the v2 format; " +
          "anything still sending v1 will now be rejected.",
        verified: { "app.py": ["why x is 2", "v1 callers break"] },
      },
    });
    assert.ok(!ok.isError, textOf(ok));
    assert.ok(existsSync(join(repo, ".learning", "checks", "feat.md")));
  } finally {
    await session.close();
  }
}

test("a full MCP session over stdio", async (t) => {
  const tmpPath = tmp(t);
  const repo = join(tmpPath, "repo");
  mkdirSync(repo);
  await sessionFlow(join(tmpPath, "home"), repo);
});

// The MCP server never executes the repo's own
//    gate script — a cloned repo could ship anything there — and it says when versions differ.
test("the MCP server never runs the repo's gate copy and flags a version difference", (t) => {
  const { dev } = setup(t);
  const marker = join(tmp(t), "PWNED");
  writeFileSync(join(dev, REPO_GATE), codeVersionStub(1, marker));
  write(dev, "src/app.js", "export const app = 2;\n");
  const out = callTool("gate_status", { repo_root: dev, base: "", branch: "" });
  assert.ok(!existsSync(marker));
  assert.ok(out.includes("src/app.js [new]") && out.includes("is v1 but the running gate is"), out);
});
