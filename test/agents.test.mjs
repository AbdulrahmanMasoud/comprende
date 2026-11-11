// The agent adapters: which AI tool a hook run comes from, what its adapter reads
// from the payload, and that every tool's hook reaches the same gate. The payloads
// are real captures, in test/fixtures/<tool>/.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  commitAll,
  ENV,
  GATE,
  gate,
  NODE,
  plugin,
  REPO,
  REPO_GATE,
  runGate,
  setup,
  sh,
  tmp as tmpDir,
  write,
} from "./helpers.mjs";

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

test("the repo comes from the payload first: Claude Code's cwd, Cursor's workspace_roots", () => {
  const dirOf = (tool, name, env, edit = (p) => p) =>
    gate.resolveAgent(JSON.stringify(edit(JSON.parse(fixture(tool, name)))), env)?.projectDir;
  assert.equal(dirOf("claude-code", "pre-tool-use.bash.ls.json", {}), "/work/probe-app");
  // Cursor's cwd is always "", so its workspace decides, then its project variables.
  const push = "pre-tool-use.shell.git-push.json";
  assert.equal(dirOf("cursor", push, { CURSOR_PROJECT_DIR: "/a" }), "/work/probe-app");
  const noWorkspace = (p) => ({ ...p, workspace_roots: [] });
  assert.equal(dirOf("cursor", push, { CURSOR_PROJECT_DIR: "/a", CLAUDE_PROJECT_DIR: "/b" }, noWorkspace), "/a");
  assert.equal(dirOf("cursor", push, { CLAUDE_PROJECT_DIR: "/b" }, noWorkspace), "/b");
  assert.equal(dirOf("cursor", push, {}, noWorkspace), null);
});

test("Cursor's plugin hook never takes its own folder for the repo: without a workspace it steps aside", (t) => {
  const { dev } = unverifiedRepo(t);
  // No repo hook file, so the plugin's hook doesn't step aside for the repo's.
  unlinkSync(join(dev, ".claude/settings.json"));
  unlinkSync(join(dev, ".cursor/hooks.json"));
  const push = JSON.parse(fixture("cursor", "pre-tool-use.shell.git-push.json"));
  const env = { ...ENV, CURSOR_PROJECT_DIR: "", CLAUDE_PROJECT_DIR: "" };
  // Run from inside the unverified repo, as if the plugin's folder were there.
  const withRoot = sh(
    dev,
    process.execPath,
    [join(REPO, "dist/gate.mjs"), "agent-hook", "--from-plugin", "--agent", "cursor"],
    {
      check: false,
      input: JSON.stringify({ ...push, workspace_roots: [dev] }),
      env,
    },
  );
  assert.equal(withRoot.status, 2, withRoot.stderr);
  const without = sh(
    dev,
    process.execPath,
    [join(REPO, "dist/gate.mjs"), "agent-hook", "--from-plugin", "--agent", "cursor"],
    {
      check: false,
      input: JSON.stringify({ ...push, workspace_roots: [] }),
      env,
    },
  );
  assert.deepEqual([without.status, without.stdout, without.stderr], [0, "", ""]);
});

test("each tool's messages name that tool, and CI's name none", (t) => {
  const { dev } = unverifiedRepo(t);
  const cursorPush = fixture("cursor", "pre-tool-use.shell.git-push.json").replaceAll("/work/probe-app", dev);
  // As the repo's .cursor/hooks.json runs it.
  assert.match(
    runGate(dev, ["agent-hook", "--agent", "cursor"], { input: cursorPush }).stderr,
    /Ask Cursor to run the ownership check/,
  );
  const claudePush = claudeCodePayload("pre-tool-use.bash.git-push.json", dev);
  assert.match(runGate(dev, ["agent-hook"], { input: claudePush }).stderr, /Ask Claude to run the ownership check/);
  const ci = runGate(dev, ["verify"]);
  assert.match(ci.stderr, /Ask your AI assistant to run the ownership check/);
  assert.doesNotMatch(ci.stderr, /Claude|Cursor/);
});

test("on a Node.js that's too old, session start names the app to restart", (t) => {
  const { dev } = setup(t);
  const preload = join(tmpDir(t), "old-node.mjs");
  writeFileSync(preload, 'Object.defineProperty(process.versions, "node", { value: "18.20.4" });\n');
  const start = (agent) =>
    JSON.parse(
      sh(
        dev,
        process.execPath,
        ["--import", pathToFileURL(preload).href, join(REPO, "dist/gate.mjs"), "session-start", "--agent", agent],
        {
          input: claudeCodePayload("session-start.json", dev),
          env: { ...ENV, OWNERSHIP_GATE_NO_AUTO_HOOK: "1" },
        },
      ).stdout,
    ).hookSpecificOutput.additionalContext;
  assert.match(start("cursor"), /Node\.js 20 or newer.*then a restart of Cursor\./);
  assert.match(start("claude-code"), /then a restart of Claude Code\./);
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
  // Two pushes, so two tool calls: one run of each name.
  const push = (id) =>
    JSON.stringify({ ...JSON.parse(claudeCodePayload("pre-tool-use.bash.git-push.json", dev)), tool_use_id: id });
  const viaAgent = runGate(dev, ["agent-hook"], { input: push("call-1") });
  const viaClaude = runGate(dev, ["claude-hook"], { input: push("call-2") });
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
    input: fixture("cursor", "pre-tool-use.shell.git-push.json").replaceAll("/work/probe-app", dev),
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^Blocked by the ownership gate:/);
});

test("from Cursor, session start finds the repo with only CURSOR_PROJECT_DIR set", (t) => {
  const { dev } = setup(t);
  unlinkSync(join(dev, ".cursor/hooks.json")); // else the repo's own file gives the gate's part
  const r = plugin(REPO, ["session-start"], {
    input: JSON.stringify({ ...JSON.parse(fixture("cursor", "session-start.json")), workspace_roots: [] }),
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
    ".cursor/hooks.json",
    ".claude/settings.json",
    ".github/CODEOWNERS",
  ]);
});

test("Cursor's repo: one workspace root, or none; several roots or none at all step aside", () => {
  const dir = (payload, env = {}, platform = "linux") => gate.cursorProjectDir(payload, env, platform);
  assert.equal(dir({ cwd: "", workspace_roots: ["/w/app"] }), "/w/app");
  assert.equal(dir({ cwd: "", workspace_roots: ["/w/app", "/w/lib"] }, { CURSOR_PROJECT_DIR: "/w/app" }), null);
  assert.equal(dir({ cwd: "", workspace_roots: [] }, { CURSOR_PROJECT_DIR: "/w/app" }), "/w/app");
  assert.equal(dir({ cwd: "" }), null);
  // Windows: Cursor sends "/c:/…", and the slash before the drive goes. Elsewhere it's a path like any other.
  assert.equal(dir({ cwd: "", workspace_roots: ["/c:/Users/dev/app"] }, {}, "win32"), "c:/Users/dev/app");
  assert.equal(dir({ cwd: "", workspace_roots: ["/c:/Users/dev/app"] }, {}, "linux"), "/c:/Users/dev/app");
});

test("the Cursor plugin's hooks, run as Cursor runs them, block an unverified push and stay silent otherwise", (t) => {
  const { dev } = unverifiedRepo(t);
  // No repo hook file, so the plugin's checks.
  unlinkSync(join(dev, ".claude/settings.json"));
  unlinkSync(join(dev, ".cursor/hooks.json"));
  const { hooks } = JSON.parse(readFileSync(join(REPO, "hooks/cursor-hooks.json"), "utf8"));
  // Cursor puts the plugin's folder in place of the variable, and runs the command from that folder.
  const run = (command, payload) =>
    sh(REPO, "/bin/sh", ["-c", command.replaceAll("${CURSOR_PLUGIN_ROOT}", REPO)], {
      check: false,
      input: payload.replaceAll("/work/probe-app", dev),
      env: { ...ENV, ...envOf("cursor"), CURSOR_PROJECT_DIR: dev, CLAUDE_PROJECT_DIR: dev },
    });
  const shell = hooks.preToolUse[0].command;
  const push = run(shell, fixture("cursor", "pre-tool-use.shell.git-push.json"));
  assert.equal(push.status, 2, push.stderr);
  assert.match(push.stderr, /Ask Cursor to run the ownership check/);
  for (const name of ["pre-tool-use.shell.ls.json", "pre-tool-use.shell.git-status.json"]) {
    const r = run(shell, fixture("cursor", name));
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], name);
  }
  const start = run(hooks.sessionStart[0].command, fixture("cursor", "session-start.json"));
  const context = JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /^Comprende is installed\./);
  assert.match(context, /This repository uses the ownership gate/);
});

// The four places a copy of the gate's hook can come from. Claude Code runs the
// two in its own format. Cursor runs its own two, and Claude Code's two only while
// Third-Party Imports is on (on by default, but a person or an admin can turn it off).
const COPIES = ["settings", "cursorHooks", "claudePlugin", "cursorPlugin"];
const combinations = (tool) =>
  Array.from({ length: 16 }, (_, n) => Object.fromEntries(COPIES.map((c, i) => [c, Boolean(n & (1 << i))]))).flatMap(
    (combo) => (tool === "cursor" ? [true, false] : [true]).map((imports) => ({ ...combo, imports })),
  );

/** Does `tool` run this copy of the hook, in `combo`? */
function runs(tool, combo, copy) {
  if (!combo[copy]) return false;
  if (tool === "claude-code") return copy === "settings" || copy === "claudePlugin";
  return combo.imports || copy === "cursorHooks" || copy === "cursorPlugin";
}

/** Runs every copy present in `combo`, for `event`, as `tool` runs it. Returns their results. */
function runCopies(dev, combo, tool, event, payload, files) {
  const PLUGIN_HOOKS = JSON.parse(readFileSync(join(REPO, "hooks/hooks.json"), "utf8")).hooks;
  const CURSOR_PLUGIN_HOOKS = JSON.parse(readFileSync(join(REPO, "hooks/cursor-hooks.json"), "utf8")).hooks;
  const claude = event === "shell" ? "PreToolUse" : "SessionStart";
  const cursor = event === "shell" ? "preToolUse" : "sessionStart";
  const commands = [];
  const repoSettings = files.settings && JSON.parse(files.settings).hooks[claude]?.[0].hooks[0].command;
  const repoCursor = files.cursorHooks && JSON.parse(files.cursorHooks).hooks[cursor]?.[0].command;
  if (runs(tool, combo, "settings") && repoSettings) commands.push([repoSettings, dev]);
  if (runs(tool, combo, "claudePlugin"))
    commands.push([PLUGIN_HOOKS[claude][0].hooks[0].command, tool === "cursor" ? REPO : dev]);
  if (runs(tool, combo, "cursorHooks") && repoCursor) commands.push([repoCursor, dev]);
  if (runs(tool, combo, "cursorPlugin")) commands.push([CURSOR_PLUGIN_HOOKS[cursor][0].command, REPO]);
  const env = {
    ...ENV,
    ...(tool === "cursor" ? envOf("cursor") : {}),
    CLAUDE_PROJECT_DIR: dev,
    CURSOR_PROJECT_DIR: tool === "cursor" ? dev : "",
    CLAUDE_PLUGIN_ROOT: REPO,
    OWNERSHIP_GATE_NO_AUTO_HOOK: "1",
  };
  return commands.map(([command, cwd]) =>
    sh(cwd, "/bin/sh", ["-c", command.replaceAll("${CURSOR_PLUGIN_ROOT}", REPO)], {
      check: false,
      input: payload,
      env,
    }),
  );
}

test("exactly one copy of the gate checks each push, whatever hook files and plugins are present", (t) => {
  const { dev } = unverifiedRepo(t);
  const files = {
    settings: readFileSync(join(dev, ".claude/settings.json"), "utf8"),
    cursorHooks: readFileSync(join(dev, ".cursor/hooks.json"), "utf8"),
  };
  let call = 0;
  for (const tool of ["cursor", "claude-code"]) {
    for (const combo of combinations(tool)) {
      for (const [copy, path] of [
        ["settings", ".claude/settings.json"],
        ["cursorHooks", ".cursor/hooks.json"],
      ]) {
        if (combo[copy]) writeFileSync(join(dev, path), files[copy]);
        else rmSync(join(dev, path), { force: true });
      }
      // A fresh tool call each time, as each real push is.
      const id = `call-${++call}`;
      const payload =
        tool === "cursor"
          ? JSON.stringify({
              ...JSON.parse(fixture("cursor", "pre-tool-use.shell.git-push.json")),
              workspace_roots: [dev],
              tool_use_id: id,
            })
          : JSON.stringify({
              ...JSON.parse(claudeCodePayload("pre-tool-use.bash.git-push.json", dev)),
              tool_use_id: id,
            });
      const results = runCopies(dev, combo, tool, "shell", payload, files);
      const checked = results.filter((r) => r.status === 2).length;
      const label = `${tool} ${JSON.stringify(combo)}`;
      assert.equal(checked, COPIES.some((copy) => runs(tool, combo, copy)) ? 1 : 0, label);
      for (const r of results.filter((r) => r.status !== 2)) assert.deepEqual([r.status, r.stdout], [0, ""], label);
    }
  }
});

test("each session starts with the always-on line once, and the gate's context once", (t) => {
  const { dev } = setup(t);
  const files = {
    settings: readFileSync(join(dev, ".claude/settings.json"), "utf8"),
    cursorHooks: readFileSync(join(dev, ".cursor/hooks.json"), "utf8"),
  };
  let session = 0;
  for (const tool of ["cursor", "claude-code"]) {
    for (const combo of combinations(tool)) {
      for (const [copy, path] of [
        ["settings", ".claude/settings.json"],
        ["cursorHooks", ".cursor/hooks.json"],
      ]) {
        if (combo[copy]) writeFileSync(join(dev, path), files[copy]);
        else rmSync(join(dev, path), { force: true });
      }
      const id = `session-${++session}`;
      const payload =
        tool === "cursor"
          ? JSON.stringify({
              ...JSON.parse(fixture("cursor", "session-start.json")),
              workspace_roots: [dev],
              session_id: id,
            })
          : JSON.stringify({ ...JSON.parse(claudeCodePayload("session-start.json", dev)), session_id: id });
      const contexts = runCopies(dev, combo, tool, "sessionStart", payload, files).map(
        (r) => JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? "",
      );
      const count = (re) => contexts.filter((c) => re.test(c)).length;
      const plugins = runs(tool, combo, "claudePlugin") || runs(tool, combo, "cursorPlugin");
      const label = `${tool} ${JSON.stringify(combo)}`;
      assert.equal(count(/Comprende is installed\./), plugins ? 1 : 0, `always-on: ${label}`);
      const repoStarts = runs(tool, combo, "cursorHooks");
      assert.equal(count(/This repository uses the ownership gate/), plugins || repoStarts ? 1 : 0, `gate: ${label}`);
    }
  }
});

/** Cursor's payload for a `git push` in `dev`, as tool call `id`. */
const cursorPush = (dev, id) =>
  JSON.stringify({
    ...JSON.parse(fixture("cursor", "pre-tool-use.shell.git-push.json")),
    workspace_roots: [dev],
    tool_use_id: id,
  });

/** Cursor's session-start payload for `dev`, as session `id`. */
const cursorSession = (dev, id) =>
  JSON.stringify({ ...JSON.parse(fixture("cursor", "session-start.json")), workspace_roots: [dev], session_id: id });

const CURSOR_ENV = { ...ENV, ...envOf("cursor"), OWNERSHIP_GATE_NO_AUTO_HOOK: "1" };

/** The plugin's gate.mjs with `args`, started without waiting, so that two copies run at the same moment. */
const startPlugin = (args, input, env) =>
  new Promise((done) => {
    const child = spawn(NODE, [GATE, ...args], { cwd: REPO, env });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => done({ status, stderr }));
    child.stdin.end(input);
  });

test("in Cursor, an old repo gate in .claude/settings.json doesn't stop the plugin's check", (t) => {
  const { dev } = unverifiedRepo(t);
  unlinkSync(join(dev, ".cursor/hooks.json"));
  // Before 0.2.2 the gate read only Claude Code's "Bash", so it let every Cursor push through.
  writeFileSync(join(dev, REPO_GATE), 'import { readFileSync } from "node:fs";\nreadFileSync(0);\n');
  const input = cursorPush(dev, "call-old-gate");
  const settings = JSON.parse(readFileSync(join(dev, ".claude/settings.json"), "utf8"));
  const env = { ...CURSOR_ENV, CLAUDE_PROJECT_DIR: dev };
  const repoRun = sh(dev, "/bin/sh", ["-c", settings.hooks.PreToolUse[0].hooks[0].command], {
    check: false,
    input,
    env,
  });
  const pluginRun = plugin(REPO, ["agent-hook", "--from-plugin", "--agent", "cursor"], { input, env });
  assert.deepEqual([repoRun.status, pluginRun.status], [0, 2], pluginRun.stderr);
});

test("two plugin copies started at the same moment: exactly one checks the push", async (t) => {
  const { dev } = unverifiedRepo(t);
  unlinkSync(join(dev, ".claude/settings.json"));
  unlinkSync(join(dev, ".cursor/hooks.json"));
  for (let round = 1; round <= 5; round++) {
    const input = cursorPush(dev, `call-race-${round}`);
    const copies = await Promise.all([
      startPlugin(["agent-hook", "--from-plugin", "--agent", "cursor"], input, CURSOR_ENV), // Cursor's own plugin
      startPlugin(["claude-hook", "--from-plugin"], input, CURSOR_ENV), // the Claude Code plugin it imports
    ]);
    assert.deepEqual(
      copies.map((c) => c.status).sort(),
      [0, 2],
      `round ${round}: ${copies.map((c) => c.stderr).join("")}`,
    );
  }
});

test("the same tool-call id in two repos is two pushes: both are checked", (t) => {
  for (const dev of [unverifiedRepo(t).dev, unverifiedRepo(t).dev]) {
    unlinkSync(join(dev, ".claude/settings.json"));
    unlinkSync(join(dev, ".cursor/hooks.json"));
    const r = plugin(REPO, ["agent-hook", "--from-plugin", "--agent", "cursor"], {
      input: cursorPush(dev, "call-same-id"),
      env: CURSOR_ENV,
    });
    assert.equal(r.status, 2, dev);
  }
});

test("in Claude Code, a session that starts again under the same id gets the always-on line again", (t) => {
  const { dev } = setup(t);
  const input = claudeCodePayload("session-start.json", dev);
  for (const run of [1, 2]) {
    const r = plugin(dev, ["session-start", "--from-plugin"], {
      input,
      env: { ...ENV, OWNERSHIP_GATE_NO_AUTO_HOOK: "1" },
    });
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /^Comprende is installed\./, `run ${run}`);
  }
});

test("a session start in .cursor/hooks.json without --from-repo doesn't make the plugin drop the gate's context", (t) => {
  const { dev } = setup(t);
  const path = join(dev, ".cursor/hooks.json");
  writeFileSync(path, readFileSync(path, "utf8").replace(" --from-repo", ""));
  const r = plugin(REPO, ["session-start", "--from-plugin", "--agent", "cursor"], {
    input: cursorSession(dev, "session-hand-written"),
    env: CURSOR_ENV,
  });
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /This repository uses the ownership gate/);
});

test("a claim goes stale after two minutes: a session that starts again later under the same id gets the always-on line", (t) => {
  const dir = tmpDir(t);
  const env = { ...CURSOR_ENV, TMPDIR: dir };
  const start = () =>
    JSON.parse(
      plugin(REPO, ["session-start", "--from-plugin", "--agent", "cursor"], {
        input: cursorSession(dir, "session-resumed"),
        env,
      }).stdout,
    ).hookSpecificOutput?.additionalContext ?? "";
  assert.match(start(), /^Comprende is installed\./);
  assert.equal(start(), "", "a second copy on the same session start stays silent");
  const folder = join(
    dir,
    readdirSync(dir).find((name) => name.startsWith("comprende-hook-runs-")),
  );
  const threeMinutesAgo = Date.now() / 1000 - 180;
  for (const claim of readdirSync(folder)) utimesSync(join(folder, claim), threeMinutesAgo, threeMinutesAgo);
  assert.match(start(), /^Comprende is installed\./);
});

test("a hook payload that starts with a UTF-8 BOM is read like any other", (t) => {
  const { dev } = unverifiedRepo(t);
  unlinkSync(join(dev, ".claude/settings.json"));
  unlinkSync(join(dev, ".cursor/hooks.json"));
  // Cursor's CLI on Windows has sent the payload with one.
  const push = plugin(REPO, ["agent-hook", "--from-plugin", "--agent", "cursor"], {
    input: `\uFEFF${cursorPush(dev, "call-bom")}`,
    env: CURSOR_ENV,
  });
  assert.equal(push.status, 2, push.stderr);
  const start = plugin(REPO, ["session-start", "--from-plugin", "--agent", "cursor"], {
    input: `\uFEFF${cursorSession(dev, "session-bom")}`,
    env: CURSOR_ENV,
  });
  assert.match(
    JSON.parse(start.stdout).hookSpecificOutput.additionalContext,
    /This repository uses the ownership gate/,
  );
});
