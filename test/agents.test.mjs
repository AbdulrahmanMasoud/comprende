// The agent adapters: which AI tool a hook run comes from, what its adapter reads
// from the payload, and that every tool's hook reaches the same gate. The payloads
// are real captures, in test/fixtures/<tool>/.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  commitAll,
  ENV,
  failingGitBin,
  GATE,
  gate,
  NODE,
  payload,
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

/** A captured Codex payload, pointed at the repo `dev`. */
const codexPayload = (name, dev) => fixture("codex", name).replaceAll("/work/probe-app", dev);

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

test("a Codex tool call is detected as Codex, and --agent codex wins for every Codex payload", () => {
  for (const name of payloadsOf("codex")) {
    assert.equal(gate.resolveAgent(fixture("codex", name), envOf("codex"), "codex")?.id, "codex", name);
    // Without --agent, as Codex runs a Claude Code plugin's hooks: only a tool call carries turn_id.
    const detected = gate.resolveAgent(fixture("codex", name), envOf("codex"))?.id;
    assert.equal(detected, name.startsWith("pre-tool-use") ? "codex" : "claude-code", name);
  }
});

test("each adapter reads the command from its own shell tool only", () => {
  const read = (tool, name) => gate.resolveAgent(fixture(tool, name), envOf(tool))?.command;
  assert.equal(read("cursor", "pre-tool-use.shell.git-push.json"), "git push origin feature/probe");
  assert.equal(read("cursor", "pre-tool-use.read.json"), null);
  assert.equal(read("claude-code", "pre-tool-use.bash.git-push.json"), "git push origin feature/probe");
  assert.equal(read("claude-code", "pre-tool-use.read.json"), null);
  assert.equal(read("codex", "pre-tool-use.bash.git-push.json"), "git push origin main");
  // Another tool's shell payload, sent to Codex's adapter, is no command for it.
  assert.equal(gate.resolveAgent(fixture("cursor", "pre-tool-use.shell.git-push.json"), {}, "codex")?.command, null);
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

test("Codex's repo comes from the payload's cwd only: without one it steps aside", () => {
  const dirOf = (payload, env) => gate.resolveAgent(JSON.stringify(payload), env, "codex")?.projectDir;
  const push = JSON.parse(fixture("codex", "pre-tool-use.bash.git-push.json"));
  assert.equal(dirOf(push, {}), "/work/probe-app");
  // Not Claude Code's variable, and not the process's folder: the hook runs in the session's folder.
  assert.equal(dirOf({ ...push, cwd: "" }, { CLAUDE_PROJECT_DIR: "/b" }), null);
});

test("in Codex, the plugin's hook checks a push even though the repo has .claude/settings.json", (t) => {
  // Codex runs the Claude Code plugin's hooks/hooks.json, so the hook gets no --agent.
  // It never runs .claude/settings.json, so stepping aside for that file left the push unchecked.
  const { dev } = unverifiedRepo(t);
  const r = plugin(REPO, ["claude-hook", "--from-plugin"], {
    input: codexPayload("pre-tool-use.bash.git-push.json", dev),
    env: { ...ENV, ...envOf("codex") },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /Ask Codex to run the ownership check/);
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
  const codexPush = codexPayload("pre-tool-use.bash.git-push.json", dev);
  assert.match(
    runGate(dev, ["agent-hook", "--agent", "codex"], { input: codexPush }).stderr,
    /Ask Codex to run the ownership check/,
  );
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
  // Antigravity's reply is an injected system message.
  const antigravity = JSON.parse(
    sh(
      dev,
      process.execPath,
      ["--import", pathToFileURL(preload).href, GATE, "session-start", "--from-plugin", "--agent", "antigravity"],
      {
        input: fixture("antigravity", "session-start.json").replaceAll("/work/probe-app", dev),
        env: { ...ENV, OWNERSHIP_GATE_NO_AUTO_HOOK: "1" },
      },
    ).stdout,
  ).injectSteps[0].systemMessage.systemMessage;
  assert.match(antigravity, /Node\.js 20 or newer.*then a restart of Antigravity\./);
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
    ".codex/hooks.json",
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

// The places a copy of the gate's hook can come from, and which tool runs each:
// - Claude Code runs the two in its own format.
// - Cursor runs its own two, and Claude Code's two only while Third-Party Imports
//   is on (on by default, but a person or an admin can turn it off).
// - Codex runs its own two, and a Claude Code plugin it installed from
//   .claude-plugin/ (an older install, or one brought over by /import), each only
//   once trusted. It never runs .claude/settings.json or .cursor/hooks.json, which
//   stay in its cases, since a gated repo has them.
const COPIES = ["settings", "cursorHooks", "claudePlugin", "cursorPlugin", "codexHooks", "codexPlugin"];
const bits = (names, n) => Object.fromEntries(names.map((c, i) => [c, Boolean(n & (1 << i))]));
function combinations(tool) {
  if (tool === "codex") {
    // Each copy absent, there but not trusted, or trusted: Codex trusts each hook on its own.
    const states = (copy) => [
      { [copy]: false },
      { [copy]: true, [`${copy}Trusted`]: false },
      { [copy]: true, [`${copy}Trusted`]: true },
    ];
    return states("codexHooks").flatMap((a) =>
      states("codexPlugin").flatMap((b) =>
        states("claudePlugin").map((c) => ({ settings: true, cursorHooks: true, ...a, ...b, ...c })),
      ),
    );
  }
  const four = Array.from({ length: 16 }, (_, n) => bits(COPIES.slice(0, 4), n));
  return four.flatMap((combo) =>
    (tool === "cursor" ? [true, false] : [true]).map((imports) => ({ ...combo, imports })),
  );
}

/** Does `tool` run this copy of the hook, in `combo`? */
function runs(tool, combo, copy) {
  if (!combo[copy]) return false;
  if (tool === "claude-code") return copy === "settings" || copy === "claudePlugin";
  if (tool === "codex") return ["codexHooks", "codexPlugin", "claudePlugin"].includes(copy) && combo[`${copy}Trusted`];
  return combo.imports || copy === "cursorHooks" || copy === "cursorPlugin";
}

/** The repo's hook files, by copy, as install writes them. */
const REPO_HOOK_FILES = [
  ["settings", ".claude/settings.json"],
  ["cursorHooks", ".cursor/hooks.json"],
  ["codexHooks", ".codex/hooks.json"],
];

/** Runs every copy present in `combo`, for `event`, as `tool` runs it. Returns their results. */
function runCopies(dev, combo, tool, event, payload, files) {
  const PLUGIN_HOOKS = JSON.parse(readFileSync(join(REPO, "hooks/hooks.json"), "utf8")).hooks;
  const CURSOR_PLUGIN_HOOKS = JSON.parse(readFileSync(join(REPO, "hooks/cursor-hooks.json"), "utf8")).hooks;
  const CODEX_PLUGIN_HOOKS = JSON.parse(readFileSync(join(REPO, "hooks/codex-hooks.json"), "utf8")).hooks;
  const claude = event === "shell" ? "PreToolUse" : "SessionStart";
  const cursor = event === "shell" ? "preToolUse" : "sessionStart";
  const commands = [];
  const repoSettings = files.settings && JSON.parse(files.settings).hooks[claude]?.[0].hooks[0].command;
  const repoCursor = files.cursorHooks && JSON.parse(files.cursorHooks).hooks[cursor]?.[0].command;
  const repoCodex = files.codexHooks && JSON.parse(files.codexHooks).hooks[claude]?.[0].hooks[0].command;
  if (runs(tool, combo, "settings") && repoSettings) commands.push([repoSettings, dev]);
  // Cursor runs a plugin's hooks from the plugin's folder; Claude Code and Codex from the session's.
  if (runs(tool, combo, "claudePlugin"))
    commands.push([PLUGIN_HOOKS[claude][0].hooks[0].command, tool === "cursor" ? REPO : dev]);
  if (runs(tool, combo, "cursorHooks") && repoCursor) commands.push([repoCursor, dev]);
  if (runs(tool, combo, "cursorPlugin")) commands.push([CURSOR_PLUGIN_HOOKS[cursor][0].command, REPO]);
  if (runs(tool, combo, "codexHooks") && repoCodex) commands.push([repoCodex, dev]);
  if (runs(tool, combo, "codexPlugin")) commands.push([CODEX_PLUGIN_HOOKS[claude][0].hooks[0].command, dev]);
  const env = {
    ...ENV,
    ...(tool === "claude-code" ? {} : envOf(tool)),
    // Claude Code and Cursor set CLAUDE_PROJECT_DIR; Codex doesn't.
    CLAUDE_PROJECT_DIR: tool === "codex" ? "" : dev,
    CURSOR_PROJECT_DIR: tool === "cursor" ? dev : "",
    CLAUDE_PLUGIN_ROOT: REPO,
    OWNERSHIP_GATE_NO_AUTO_HOOK: "1",
  };
  // Cursor and Codex replace their plugin-root variables as text before the shell
  // runs. Claude Code leaves ${CLAUDE_PLUGIN_ROOT} to the shell, which reads env.
  const asRun = (command) => {
    let text = command.replaceAll("${CURSOR_PLUGIN_ROOT}", REPO).replaceAll("${PLUGIN_ROOT}", REPO);
    if (tool !== "claude-code") text = text.replaceAll("${CLAUDE_PLUGIN_ROOT}", REPO);
    return text;
  };
  return commands.map(([command, cwd]) =>
    sh(cwd, "/bin/sh", ["-c", asRun(command)], {
      check: false,
      input: payload,
      env,
    }),
  );
}

/** The repo's hook files as install wrote them, to put back or take away per case. */
const readRepoHookFiles = (dev) =>
  Object.fromEntries(REPO_HOOK_FILES.map(([copy, path]) => [copy, readFileSync(join(dev, path), "utf8")]));
function placeRepoHookFiles(dev, combo, files) {
  for (const [copy, path] of REPO_HOOK_FILES) {
    if (combo[copy]) writeFileSync(join(dev, path), files[copy]);
    else rmSync(join(dev, path), { force: true });
  }
}

/** Each tool's own payload for `event` in `dev`, as tool call or session `id`. */
function payloadFor(tool, event, dev, id) {
  const key = event === "shell" ? "tool_use_id" : "session_id";
  if (tool === "cursor") {
    const name = event === "shell" ? "pre-tool-use.shell.git-push.json" : "session-start.json";
    return JSON.stringify({ ...JSON.parse(fixture("cursor", name)), workspace_roots: [dev], [key]: id });
  }
  const name = event === "shell" ? "pre-tool-use.bash.git-push.json" : "session-start.json";
  const text = tool === "codex" ? codexPayload(name, dev) : claudeCodePayload(name, dev);
  return JSON.stringify({ ...JSON.parse(text), [key]: id });
}

test("exactly one copy of the gate checks each push, whatever hook files and plugins are present", (t) => {
  const { dev } = unverifiedRepo(t);
  const files = readRepoHookFiles(dev);
  let call = 0;
  for (const tool of ["cursor", "claude-code", "codex"]) {
    for (const combo of combinations(tool)) {
      placeRepoHookFiles(dev, combo, files);
      // A fresh tool call each time, as each real push is.
      const payload = payloadFor(tool, "shell", dev, `call-${++call}`);
      const results = runCopies(dev, combo, tool, "shell", payload, files);
      const checked = results.filter((r) => r.status === 2).length;
      const label = `${tool} ${JSON.stringify(combo)}`;
      assert.equal(checked, COPIES.some((copy) => runs(tool, combo, copy)) ? 1 : 0, label);
      for (const r of results.filter((r) => r.status !== 2)) assert.deepEqual([r.status, r.stdout], [0, ""], label);
    }
  }
});

/** How many copies give each session line in `combo`: the always-on line, the
 *  gate's context, and Codex's note for a plugin that isn't running. */
function expectedSessionLines(tool, combo) {
  const plugins = ["claudePlugin", "cursorPlugin", "codexPlugin"].some((copy) => runs(tool, combo, copy));
  const repoStarts = runs(tool, combo, "cursorHooks") || runs(tool, combo, "codexHooks");
  // Only Codex may skip an installed plugin's hooks, so only its repo hook says how to tell.
  const note = runs(tool, combo, "codexHooks") ? 1 : 0;
  // A known limit (docs/agents.md, "Codex: the design"): a Claude Code plugin copy in
  // a Codex session. A Codex session start has no turn_id, so that copy reads it as
  // Claude Code's, which claims no session start, and it speaks whatever else runs.
  // The Codex copies (the plugin and the repo's hook) share their claims.
  if (tool === "codex" && runs(tool, combo, "claudePlugin")) {
    const codexCopies = ["codexPlugin", "codexHooks"].some((copy) => runs(tool, combo, copy));
    return { alwaysOn: runs(tool, combo, "codexPlugin") ? 2 : 1, gateContext: codexCopies ? 2 : 1, note };
  }
  return { alwaysOn: plugins ? 1 : 0, gateContext: plugins || repoStarts ? 1 : 0, note };
}

test("each session gets the always-on line, the gate's context and Codex's plugin-not-running note once each", (t) => {
  const { dev } = setup(t);
  const files = readRepoHookFiles(dev);
  let session = 0;
  for (const tool of ["cursor", "claude-code", "codex"]) {
    for (const combo of combinations(tool)) {
      placeRepoHookFiles(dev, combo, files);
      const payload = payloadFor(tool, "sessionStart", dev, `session-${++session}`);
      const contexts = runCopies(dev, combo, tool, "sessionStart", payload, files).map(
        (r) => JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? "",
      );
      const count = (re) => contexts.filter((c) => re.test(c)).length;
      const expected = expectedSessionLines(tool, combo);
      const label = `${tool} ${JSON.stringify(combo)}`;
      assert.equal(count(/Comprende is installed\./), expected.alwaysOn, `always-on: ${label}`);
      assert.equal(count(/This repository uses the ownership gate/), expected.gateContext, `gate: ${label}`);
      assert.equal(count(/Comprende's plugin isn't running in Codex/), expected.note, `note: ${label}`);
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

/** The usage-error and bad-input cases can't reach an adapter, so they can't
 *  print an adapter's deny. Exit 2 is the deny that any tool reads. */
const exitsTwo = (r) => r.status === 2;

test("a usage error or bad input never produces a deny, from any hook entry point", (t) => {
  const { dev } = unverifiedRepo(t);
  const inputs = {
    "not JSON": "git push",
    "a JSON list": "[]",
    empty: "",
    "fields of the wrong type": JSON.stringify({ tool_name: 5, tool_input: "git push", cwd: 7 }),
  };
  for (const command of ["agent-hook", "claude-hook", "session-start"]) {
    const runs = [
      ["an unknown option", [command, "--bogus"], "{}"],
      ["a missing value", [command, "--agent"], "{}"],
      ["an unknown --agent", [command, "--agent", "no-such-tool"], "{}"],
      ...Object.entries(inputs).map(([name, input]) => [`stdin ${name}`, [command], input]),
    ];
    for (const [name, args, input] of runs) {
      const r = runGate(dev, args, { input });
      assert.ok(!exitsTwo(r), `${command}, ${name}: exit ${r.status}`);
      // Session start prints context, never a decision. The shell hooks print nothing here.
      if (command !== "session-start") assert.equal(r.stdout, "", `${command}, ${name}`);
    }
  }
  // Git blocks a push on any non-zero exit, so the git hook must exit 0.
  for (const [name, args, input] of [
    ["an unknown option", ["pre-push", "--bogus"], ""],
    ["a missing value", ["pre-push", "--repo"], ""],
    ["stdin that isn't git's", ["pre-push", "origin", "url"], "not a ref line"],
  ]) {
    assert.equal(runGate(dev, args, { input }).status, 0, `pre-push, ${name}`);
  }
});

test("for every agent, only a verdict on the change blocks a push: a crash never does", {
  skip: process.platform === "win32",
}, (t) => {
  const { dev } = unverifiedRepo(t);
  const pushes = {
    "claude-code": claudeCodePayload("pre-tool-use.bash.git-push.json", dev),
    cursor: cursorPush(dev, "call"),
    codex: codexPayload("pre-tool-use.bash.git-push.json", dev),
    antigravity: fixture("antigravity", "pre-tool-use.run-command.git-push.json").replaceAll("/work/probe-app", dev),
  };
  assert.deepEqual(Object.keys(pushes).sort(), [...gate.const("AGENT_IDS")].sort(), "a case for every adapter");
  const failingGit = failingGitBin(t);
  const branch = sh(dev, "git", ["branch", "--show-current"]).stdout.trim();
  const commitThen = (path, text, check) => {
    write(dev, path, text);
    commitAll(dev, `with ${path} changed`);
    check();
    sh(dev, "git", ["reset", "-q", "--hard", "HEAD~1"]);
  };
  let call = 0;
  for (const [id, push] of Object.entries(pushes)) {
    const allow = gate.allowReply(id);
    const deny = gate.denyReply(id, "a reason");
    // A fresh tool call each time, so no run loses its claim to an earlier one. Each
    // tool names it its own way: tool_use_id (Claude's format), toolCall.id (Antigravity).
    const run = (input, env = ENV) => {
      const p = JSON.parse(input);
      const fresh = `call-${++call}`;
      return runGate(dev, ["agent-hook", "--agent", id], {
        input: JSON.stringify({
          ...p,
          tool_use_id: fresh,
          ...(p.toolCall ? { toolCall: { ...p.toolCall, id: fresh } } : {}),
        }),
        env,
      });
    };
    const allows = (r, why) => assert.deepEqual([r.status, r.stdout], [allow.exitCode, allow.stdout], `${id}: ${why}`);
    // A block is the adapter's own deny: exit 2 by default, a JSON deny on exit 0 in Antigravity.
    const blocks = (r, why) => {
      assert.equal(r.status, deny.exitCode, `${id}: ${why}`);
      if (deny.stdout) assert.equal(JSON.parse(r.stdout).decision, JSON.parse(deny.stdout).decision, `${id}: ${why}`);
    };
    // Not verdicts: the hook couldn't check, so the command runs, as the adapter allows it.
    allows(run(push.replaceAll(dev, `${dev}-missing`)), "the repo's folder is missing");
    allows(run(push, { ...ENV, PATH: `${failingGit}:${ENV.PATH}` }), "git fails during the check");
    commitThen(".learning/config.json", "{ not json", () => allows(run(push), "the config is broken"));
    // Verdicts: the check ran, and the change isn't verified.
    blocks(run(push), "an unverified push");
    commitThen(gate.reportRelpath(branch), "not a report\n", () => blocks(run(push), "a broken report"));
    commitThen(gate.reportRelpath(branch), "x".repeat(5 * 1024 * 1024), () =>
      blocks(run(push), "a report too large to read"),
    );
  }
});

test("a report from another gate version blocks the git hook, but not the agents' hook", (t) => {
  // The plugin's copy of the gate may be newer than the repo's, and CI runs the
  // base's, so in the agents' hook a version gap says nothing about the change.
  const { dev } = unverifiedRepo(t);
  gate.save(payload(), dev);
  const path = join(dev, gate.reportRelpath(sh(dev, "git", ["branch", "--show-current"]).stdout.trim()));
  writeFileSync(path, readFileSync(path, "utf8").replace(/"version": \d+/, '"version": 999'));
  commitAll(dev, "a report from another version");
  const hook = runGate(dev, ["agent-hook"], { input: claudeCodePayload("pre-tool-use.bash.git-push.json", dev) });
  assert.deepEqual([hook.status, hook.stdout], [0, ""], hook.stderr);
  const sha = sh(dev, "git", ["rev-parse", "HEAD"]).stdout.trim();
  const branch = sh(dev, "git", ["branch", "--show-current"]).stdout.trim();
  const prePush = runGate(dev, ["pre-push", "origin", "url"], {
    input: `refs/heads/${branch} ${sha} refs/heads/${branch} ${"0".repeat(40)}\n`,
  });
  assert.notEqual(prePush.status, 0);
  assert.match(prePush.stderr, /Report was made by gate v999/);
});

// GitHub's runners have pwsh, so the PowerShell case runs in CI. Locally it's skipped without it.
const PWSH = spawnSync("/bin/sh", ["-c", "command -v pwsh"], { encoding: "utf8" }).stdout.trim();

/** Runs the session start in `dev`'s .codex/hooks.json from `cwd`, as Codex does,
 *  and returns the context it gives. Each call is a new session. */
let codexSession = 0;
function codexRepoSessionStart(dev, cwd) {
  const [{ hooks }] = JSON.parse(readFileSync(join(dev, ".codex/hooks.json"), "utf8")).hooks.SessionStart;
  const input = JSON.stringify({
    ...JSON.parse(codexPayload("session-start.json", cwd)),
    session_id: `repo-session-${++codexSession}`,
  });
  const r = sh(cwd, "/bin/sh", ["-c", hooks[0].command], { check: false, input, env: ENV });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? "";
}

// After a plugin update Codex skips the plugin's hooks without a word, but the
// repo's session start keeps its trust, so it's the one that can say so.
test("the repo's .codex/hooks.json session start, from a subfolder, gives the gate's context and the plugin-not-running note", {
  skip: process.platform === "win32",
}, (t) => {
  const { dev } = setup(t);
  const sub = join(dev, "src");
  mkdirSync(sub, { recursive: true });
  const context = codexRepoSessionStart(dev, sub);
  assert.match(context, /This repository uses the ownership gate/);
  assert.match(
    context,
    /didn't also get a note starting with "Comprende is installed", Comprende's plugin isn't running in Codex/,
  );
  assert.doesNotMatch(context, /Comprende is installed\./, "the always-on line is the plugin's to give");
  assert.ok(context.includes(`"${gate.const("PLUGIN_LINE_START")}"`), "the note quotes how the plugin's line starts");

  // With the gate off, nothing: the note is only for a gated repo.
  const config = JSON.parse(readFileSync(join(dev, ".learning/config.json"), "utf8"));
  config.ownership_check.mode = "off";
  writeFileSync(join(dev, ".learning/config.json"), JSON.stringify(config));
  assert.equal(codexRepoSessionStart(dev, sub), "", "mode off");
});

// A teammate on Codex may never have installed the plugin: only the repo's hooks run.
// A real run had the agent tell them to "trust the hooks again", which they never had.
test("the repo's Codex note doesn't assume the plugin is installed: it names both cases, and both ways out", {
  skip: process.platform === "win32",
}, (t) => {
  const { dev } = setup(t);
  const context = codexRepoSessionStart(dev, dev);
  assert.match(context, /either it isn't installed, or its hooks were skipped/);
  assert.match(
    context,
    /with both options: install the plugin \(.+\), or, if it's installed, trust its hooks in `\/hooks`/,
  );
  // The install commands are the README's, so a rename can't leave the note behind.
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const commands = [...context.matchAll(/`(codex plugin [^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(commands, [
    "codex plugin marketplace add AbdulrahmanMasoud/comprende",
    "codex plugin add comprende@comprende",
  ]);
  for (const command of commands) assert.ok(readme.includes(command), `README.md: ${command}`);
});

test("the repo's .codex/hooks.json blocks an unverified push from a subfolder, and fails open without git or node", {
  skip: process.platform === "win32",
}, (t) => {
  const { dev: made, tmp } = unverifiedRepo(t);
  // A path with a space and a literal $HOME: the command's own $(…) must not expand them.
  const dev = join(tmp, "my repo $HOME", "dev");
  mkdirSync(dirname(dev));
  renameSync(made, dev);
  const [{ hooks }] = JSON.parse(readFileSync(join(dev, ".codex/hooks.json"), "utf8")).hooks.PreToolUse;
  const command = hooks[0].command;
  // Codex runs hooks in the session's folder, which may be a subfolder.
  const sub = join(dev, "src");
  let call = 0;
  const input = () =>
    JSON.stringify({
      ...JSON.parse(codexPayload("pre-tool-use.bash.git-push.json", sub)),
      tool_use_id: `call-${++call}`,
    });
  const run = (env) => sh(sub, "/bin/sh", ["-c", command], { check: false, input: input(), env });
  const push = run(ENV);
  assert.equal(push.status, 2, push.stderr);
  assert.match(push.stderr, /Ask Codex to run the ownership check/);
  // Only node on PATH, no git: the command can't find the gate, and fails open.
  const nodeOnly = join(tmpDir(t), "node-only");
  mkdirSync(nodeOnly);
  symlinkSync(NODE, join(nodeOnly, "node"));
  assert.notEqual(run({ ...ENV, PATH: nodeOnly }).status, 2, "without git");
  assert.notEqual(run({ ...ENV, PATH: tmpDir(t) }).status, 2, "without node");
  // On Windows, Codex runs hooks in PowerShell (-Command), which reads the same $(…):
  // the gate finds the repo and blocks. But -Command turns a program's exit 2 into
  // 1 unless the command ends with `exit $LASTEXITCODE`, so the block doesn't reach
  // the tool as exit 2: on Windows the push guard fails open (#10).
  if (PWSH) {
    const ps = spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-Command", `$input | ${command}`], {
      cwd: sub,
      input: input(),
      encoding: "utf8",
      env: ENV,
    });
    assert.match(ps.stderr, /Blocked by the ownership gate/, "PowerShell finds the gate and it blocks");
    assert.equal(ps.status, 1, "PowerShell's -Command turns exit 2 into 1");
  }
});

/** A captured Antigravity payload, pointed at the repo `dev`. */
const antigravityPayload = (name, dev) => fixture("antigravity", name).replaceAll("/work/probe-app", dev);

test("every Antigravity payload is detected as Antigravity, and --agent antigravity wins", () => {
  for (const name of payloadsOf("antigravity")) {
    assert.equal(gate.resolveAgent(fixture("antigravity", name), {}, "antigravity")?.id, "antigravity", name);
    // Without --agent, as Antigravity runs a converted Claude Code plugin's hooks.
    assert.equal(gate.resolveAgent(fixture("antigravity", name), {})?.id, "antigravity", name);
  }
});

test("Antigravity's command is run_command's CommandLine, and its repo the command's Cwd, then cwd", () => {
  const read = (payload) => gate.resolveAgent(JSON.stringify(payload), {}, "antigravity");
  const push = JSON.parse(fixture("antigravity", "pre-tool-use.run-command.git-push.json"));
  assert.equal(read(push).command, "git push origin feature/sum");
  assert.equal(read({ ...push, toolCall: { ...push.toolCall, name: "write_to_file" } }).command, null);
  assert.equal(read(push).projectDir, "/work/probe-app");
  const withCwd = (Cwd) => ({ ...push, toolCall: { ...push.toolCall, args: { ...push.toolCall.args, Cwd } } });
  assert.equal(read(withCwd("/work/other")).projectDir, "/work/other");
  // A relative Cwd is seen from the workspace's folder.
  assert.equal(read(withCwd("sub")).projectDir, "/work/probe-app/sub");
  // Without an absolute cwd, no guess: a wrong repo would mean a deny that isn't a verdict
  // on this push. Never the process's folder either: Antigravity runs plugin hooks in the plugin's.
  assert.equal(read({ ...withCwd("sub"), cwd: "work" }).projectDir, null);
  assert.equal(read({ ...push, cwd: "work" }).projectDir, null);
  assert.equal(read({ ...push, cwd: "" }).projectDir, null);
});

test("from Antigravity, an unverified push gets a JSON deny on exit 0, and ls an empty allow", (t) => {
  const { dev } = unverifiedRepo(t);
  const hook = (name) =>
    runGate(dev, ["agent-hook", "--from-plugin", "--agent", "antigravity"], { input: antigravityPayload(name, dev) });
  const push = hook("pre-tool-use.run-command.git-push.json");
  assert.equal(push.status, 0, push.stderr);
  const reply = JSON.parse(push.stdout);
  assert.deepEqual(Object.keys(reply), ["decision", "reason"]);
  assert.equal(reply.decision, "deny");
  assert.match(reply.reason, /No ownership report for branch 'feature\/rate-limit'/);
  assert.match(reply.reason, /Ask Antigravity to run the ownership check/);
  const ls = hook("pre-tool-use.run-command.ls.json");
  assert.deepEqual([ls.status, ls.stdout], [0, ""]);
});

test("from Antigravity's own hook file, session start says the hooks run, and gives the gate's note as a system message", (t) => {
  const { dev } = unverifiedRepo(t);
  const start = (input, args = ["--agent", "antigravity"], extra = {}) =>
    runGate(dev, ["session-start", "--from-plugin", ...args], {
      input,
      env: { ...ENV, OWNERSHIP_GATE_NO_AUTO_HOOK: "1", TMPDIR: tmpDir(t), ...extra },
    });
  const contextOf = (r) => {
    const reply = JSON.parse(r.stdout);
    // Only the shape Antigravity accepts: any field it doesn't know fails the whole reply.
    assert.deepEqual(Object.keys(reply), ["injectSteps"]);
    assert.deepEqual(Object.keys(reply.injectSteps[0]), ["systemMessage"]);
    return reply.injectSteps[0].systemMessage.systemMessage;
  };
  const payload = antigravityPayload("session-start.json", dev);
  const own = contextOf(start(payload));
  assert.match(own, /This repository uses the ownership gate \(mode: required\)/);
  // The plugin's rules/AGENTS.md gives the instruction. The session start only says the hooks
  // ran, in the words the skill looks for: a rule loads even where hooks don't run.
  assert.ok(own.startsWith(gate.const("HOOKS_RUN_LINE")), own);
  assert.ok(!own.includes(gate.const("ALWAYS_ON_RULE")), own);
  // A copy converted from the Claude Code plugin (no --agent) may come without the rule: the full line.
  assert.ok(contextOf(start(payload, [])).startsWith(gate.const("ALWAYS_ON")));
  // Quiet mode sends its own line, as in every tool.
  assert.ok(contextOf(start(payload, undefined, { COMPRENDE_QUIET: "1" })).startsWith(gate.const("QUIET_MODE")));
  // Outside a gated repo, only the line that says the hooks run.
  assert.equal(contextOf(start(antigravityPayload("session-start.json", tmpDir(t)))), gate.const("HOOKS_RUN_LINE"));
});

test("in Antigravity, with the plugin and a converted copy, the session's lines come once", (t) => {
  const { dev } = unverifiedRepo(t);
  const env = { ...ENV, OWNERSHIP_GATE_NO_AUTO_HOOK: "1", TMPDIR: tmpDir(t) };
  const payload = antigravityPayload("session-start.json", dev);
  // Both claim the session's conversationId: the first one speaks, the other replies {}.
  const own = runGate(dev, ["session-start", "--from-plugin", "--agent", "antigravity"], { input: payload, env });
  const converted = runGate(dev, ["session-start", "--from-plugin"], { input: payload, env });
  assert.match(own.stdout, /ownership gate/);
  assert.equal(converted.stdout.trim(), "{}");
});

test("with --agent antigravity, input that isn't JSON still gets Antigravity's replies, never a block", (t) => {
  const { dev } = unverifiedRepo(t);
  for (const input of ["not json", "{"]) {
    const start = runGate(dev, ["session-start", "--from-plugin", "--agent", "antigravity"], { input });
    assert.equal(start.status, 0, start.stderr);
    assert.ok(!start.stdout.includes("hookSpecificOutput"), start.stdout);
    assert.equal(JSON.parse(start.stdout).injectSteps[0].systemMessage.systemMessage, gate.const("HOOKS_RUN_LINE"));
    const hook = runGate(dev, ["agent-hook", "--from-plugin", "--agent", "antigravity"], { input });
    assert.deepEqual([hook.status, hook.stdout], [0, ""], JSON.stringify(input));
  }
});

test("in Antigravity, the plugin and a converted Claude Code copy of it check a push once", (t) => {
  const { dev } = unverifiedRepo(t);
  // One push, seen by two plugin copies: Comprende's own hooks.json, and the hooks
  // `agy plugin import claude` converts from hooks/hooks.json, which pass no --agent.
  const push = antigravityPayload("pre-tool-use.run-command.git-push.json", dev);
  const env = { ...ENV, TMPDIR: tmpDir(t) };
  const own = runGate(dev, ["agent-hook", "--from-plugin", "--agent", "antigravity"], { input: push, env });
  const converted = runGate(dev, ["claude-hook", "--from-plugin"], { input: push, env });
  const denies = [own, converted].filter((r) => r.stdout.includes('"deny"'));
  assert.equal(denies.length, 1, `${own.stdout} | ${converted.stdout}`);
  assert.ok([own, converted].every((r) => r.status === 0));
});
