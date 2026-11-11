// The agent adapters: which AI tool a hook run comes from, what its adapter reads
// from the payload, and that every tool's hook reaches the same gate. The payloads
// are real captures, in test/fixtures/<tool>/.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitAll, ENV, gate, plugin, REPO, REPO_GATE, runGate, setup, sh, tmp as tmpDir, write } from "./helpers.mjs";

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
  // Cursor's cwd is always "". It sets both variables to the same path; CLAUDE_PROJECT_DIR comes first.
  const push = "pre-tool-use.shell.git-push.json";
  assert.equal(dirOf("cursor", push, { CLAUDE_PROJECT_DIR: "/b", CURSOR_PROJECT_DIR: "/a" }), "/b");
  assert.equal(dirOf("cursor", push, { CURSOR_PROJECT_DIR: "/a" }), "/a");
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

test("a Shell payload is Cursor's even without cursor_version: only Cursor calls its shell tool that", () => {
  const payload = JSON.stringify({ tool_name: "Shell", tool_input: { command: "git push" }, cwd: "" });
  assert.deepEqual(gate.resolveAgent(payload, {}), { id: "cursor", command: "git push", projectDir: null });
});

test("agent-hook --agent cursor blocks an unverified push from a Cursor payload", (t) => {
  const { dev } = unverifiedRepo(t);
  const r = runGate(dev, ["agent-hook", "--agent", "cursor"], {
    input: fixture("cursor", "pre-tool-use.shell.git-push.json"),
    env: { ...ENV, CURSOR_PROJECT_DIR: dev },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^Blocked by the ownership gate:/);
});

test("from Cursor, session start finds the repo with only CURSOR_PROJECT_DIR set", (t) => {
  const { dev } = setup(t);
  const r = plugin(REPO, ["session-start"], {
    input: fixture("cursor", "session-start.json"),
    env: { ...ENV, CURSOR_PROJECT_DIR: dev, OWNERSHIP_GATE_NO_AUTO_HOOK: "1" },
  });
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /This repository uses the ownership gate/);
});

test("an unknown --agent still gets the always-on line at session start, but no repo context", (t) => {
  const { dev } = setup(t);
  const r = runGate(dev, ["session-start", "--agent", "no-such-tool"], {
    input: claudeCodePayload("session-start.json", dev),
  });
  const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /^Comprende is installed\./);
  assert.doesNotMatch(context, /ownership gate/);
});

test("a repo hook file that calls agent-hook counts as running the gate", (t) => {
  const { dev } = unverifiedRepo(t);
  const settingsPath = join(dev, ".claude/settings.json");
  const settings = readFileSync(settingsPath, "utf8").replace("claude-hook", "agent-hook");
  writeFileSync(settingsPath, settings);
  commitAll(dev, "the repo's hook under its new name");
  const input = claudeCodePayload("pre-tool-use.bash.git-push.json", dev);
  assert.deepEqual(plugin(REPO, ["claude-hook", "--from-plugin"], { input }).status, 0); // steps aside
  assert.match(gate.mergeClaudeSettings(settingsPath), /^Claude hook already present/);
});

test("install merges its hook into a .claude/settings.json whose entries have shapes it doesn't know", (t) => {
  const path = join(tmpDir(t), "settings.json");
  writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [null, { hooks: "x" }, { hooks: [{ command: 5 }] }] } }));
  assert.match(gate.mergeClaudeSettings(path), /^merged a Claude Code PreToolUse hook into /);
  const groups = JSON.parse(readFileSync(path, "utf8")).hooks.PreToolUse;
  assert.equal(groups.length, 4);
  assert.match(groups[3].hooks[0].command, /gate\.mjs" claude-hook$/);
});

test("GATE_FILES lists the gate's own files, in a fixed order", () => {
  assert.deepEqual(gate.const("GATE_FILES"), [
    ".learning/config.json",
    REPO_GATE,
    ".github/workflows/ownership-check.yml",
    ".claude/settings.json",
    ".github/CODEOWNERS",
  ]);
});
