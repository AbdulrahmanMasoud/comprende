// The agent adapters: which AI tool a hook run comes from, what its adapter reads
// from the payload, and that every tool's hook reaches the same gate. The payloads
// are real captures, in test/fixtures/<tool>/.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitAll, ENV, gate, REPO, runGate, setup, sh, write } from "./helpers.mjs";

const FIXTURES = join(REPO, "test/fixtures");
const fixture = (tool, name) => readFileSync(join(FIXTURES, tool, name), "utf8");
const payloadsOf = (tool) =>
  readdirSync(join(FIXTURES, tool)).filter((f) => f.endsWith(".json") && f !== "hook-env.json");
const envOf = (tool) => JSON.parse(fixture(tool, "hook-env.json"));

/** A captured Claude Code payload, pointed at the repo `dev`. */
const claudeCodePayload = (name, dev) => fixture("claude-code", name).replaceAll("/work/probe-app", dev);

/** An unverified change on a branch of a gated repo. */
function unverifiedRepo(t) {
  const { dev, tmp } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked");
  return { dev, tmp };
}

test("every Cursor payload resolves to Cursor, and every Claude Code payload to Claude Code", () => {
  for (const name of payloadsOf("cursor"))
    assert.equal(gate.resolveAgent(fixture("cursor", name), envOf("cursor"))?.id, "cursor", name);
  for (const name of payloadsOf("claude-code"))
    assert.equal(gate.resolveAgent(fixture("claude-code", name), envOf("claude-code"))?.id, "claude-code", name);
});

test("each adapter reads the command from its own shell tool only", () => {
  const read = (tool, name) => gate.resolveAgent(fixture(tool, name), envOf(tool))?.command;
  assert.equal(read("cursor", "pre-tool-use.shell.git-push.json"), "git push origin feature/probe");
  assert.equal(read("cursor", "pre-tool-use.read.json"), null);
  assert.equal(read("claude-code", "pre-tool-use.bash.git-push.json"), "git push origin feature/probe");
  assert.equal(read("claude-code", "pre-tool-use.read.json"), null);
});

test("the repo comes from the payload's cwd, else the tool's project variable", () => {
  const dirOf = (tool, name, env) => gate.resolveAgent(fixture(tool, name), env)?.projectDir;
  assert.equal(dirOf("claude-code", "pre-tool-use.bash.ls.json", {}), "/work/probe-app");
  // Cursor's cwd is always "".
  const push = "pre-tool-use.shell.git-push.json";
  assert.equal(dirOf("cursor", push, { CURSOR_PROJECT_DIR: "/a", CLAUDE_PROJECT_DIR: "/b" }), "/a");
  assert.equal(dirOf("cursor", push, { CLAUDE_PROJECT_DIR: "/b" }), "/b");
  assert.equal(dirOf("cursor", push, {}), null);
});

test("--agent wins over detection, and an unknown --agent resolves to no adapter", () => {
  const push = fixture("cursor", "pre-tool-use.shell.git-push.json");
  assert.equal(gate.resolveAgent(push, envOf("cursor"), "claude-code")?.id, "claude-code");
  assert.equal(gate.resolveAgent(push, envOf("cursor"), "no-such-tool"), null);
});

test("from Claude Code, a real payload's unverified push is blocked, and ls passes silently", (t) => {
  const { dev } = unverifiedRepo(t);
  const settings = JSON.parse(readFileSync(join(dev, ".claude/settings.json"), "utf8"));
  const projectHook = settings.hooks.PreToolUse[0].hooks[0].command;
  const run = (name) =>
    sh(dev, "/bin/sh", ["-c", projectHook], {
      check: false,
      input: claudeCodePayload(name, dev),
      env: { ...ENV, CLAUDE_PROJECT_DIR: dev },
    });
  const push = run("pre-tool-use.bash.git-push.json");
  assert.equal(push.status, 2, push.stderr);
  assert.match(push.stderr, /^Blocked by the ownership gate:\n- No ownership report for branch 'feature\/rate-limit'/);
  for (const name of ["pre-tool-use.bash.ls.json", "pre-tool-use.bash.git-status.json", "pre-tool-use.read.json"]) {
    const r = run(name);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], name);
  }
});

test("agent-hook and claude-hook are the same command", (t) => {
  const { dev } = unverifiedRepo(t);
  const input = claudeCodePayload("pre-tool-use.bash.git-push.json", dev);
  const viaAgent = runGate(dev, ["agent-hook"], { input });
  const viaClaude = runGate(dev, ["claude-hook"], { input });
  assert.equal(viaAgent.status, 2);
  assert.deepEqual(
    [viaAgent.status, viaAgent.stdout, viaAgent.stderr],
    [viaClaude.status, viaClaude.stdout, viaClaude.stderr],
  );
});

test("an unknown --agent steps aside silently, even for an unverified push", (t) => {
  const { dev } = unverifiedRepo(t);
  const input = claudeCodePayload("pre-tool-use.bash.git-push.json", dev);
  const r = runGate(dev, ["agent-hook", "--agent", "no-such-tool"], { input });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
});

test("from Claude Code, session start finds the repo through the payload's cwd", (t) => {
  const { dev } = setup(t);
  const r = runGate(dev, ["session-start"], {
    input: claudeCodePayload("session-start.json", dev),
    env: { ...ENV, OWNERSHIP_GATE_NO_AUTO_HOOK: "1" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    JSON.parse(r.stdout).hookSpecificOutput.additionalContext,
    /This repository uses the ownership gate \(mode: required\)/,
  );
});
