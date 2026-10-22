// Port of mcp/tests/test_plugin_features.py.
// Plugin-era features: SessionStart auto-setup, the plugin's hook deferring to
// the repo's gate, the CI job summary for reviewers, and `protect`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { ENV, REPO, REPO_GATE, SUMMARY, commitAll, gate, gateCli, git, runGate, setup, throwsGate, tmp as tmpDir, write } from "./helpers.mjs";

/** The plugin's copy of the gate (dist/gate.mjs), like the Python `plugin()`. */
const plugin = (cwd, args, { input = "", env } = {}) => gateCli(args, { input, env: env ?? ENV, cwd });

const isExecutable = (p) => {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
};

// JS equivalent of the Python code_write_marker() for GATE_IMPL=node.
const codeWriteMarker = (marker) => `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'x');\n`;

// ---------------------------------------------------------------- SessionStart

test("session start installs hook once and adds context", (t) => {
  const { dev, tmp } = setup(t);
  const hook = join(dev, ".git/hooks/pre-push");
  unlinkSync(hook);
  const ev = JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: dev });
  const out = JSON.parse(plugin(tmp, ["session-start"], { input: ev }).stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(ctx.includes("ownership gate (mode: required)") && ctx.includes("just installed"));
  assert.ok(existsSync(hook) && isExecutable(hook));
  const again = JSON.parse(plugin(tmp, ["session-start"], { input: ev }).stdout);
  assert.ok(!again.hookSpecificOutput.additionalContext.includes("just installed"));
});

test("session start respects opt out, foreign hooks and quiet repos", (t) => {
  const { dev, tmp } = setup(t);
  const hook = join(dev, ".git/hooks/pre-push");
  unlinkSync(hook);
  const ev = JSON.stringify({ cwd: dev });
  plugin(tmp, ["session-start"], { input: ev, env: { ...ENV, OWNERSHIP_GATE_NO_AUTO_HOOK: "1" } });
  assert.ok(!existsSync(hook));

  writeFileSync(hook, "#!/bin/sh\necho mine\n");
  const ctx = JSON.parse(plugin(tmp, ["session-start"], { input: ev }).stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("wasn't added") && ctx.includes("already exists"));
  assert.equal(readFileSync(hook, "utf8"), "#!/bin/sh\necho mine\n");

  const plain = join(tmp, "plain");
  git(tmp, "init", "-q", "-b", "main", plain);
  for (const stdin of [JSON.stringify({ cwd: plain }), JSON.stringify({ cwd: "/" }), "not json", ""]) {
    const r = plugin(tmp, ["session-start"], { input: stdin });
    assert.ok(r.status === 0, `stdin ${JSON.stringify(stdin)}: exit ${r.status}`);
    assert.deepEqual(JSON.parse(r.stdout), {});
  }
});

test("session start silent when gate is off", (t) => {
  const { dev, tmp } = setup(t);
  const cfgPath = join(dev, ".learning/config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.ownership_check.mode = "off";
  writeFileSync(cfgPath, JSON.stringify(cfg));
  assert.deepEqual(JSON.parse(plugin(tmp, ["session-start"], { input: JSON.stringify({ cwd: dev }) }).stdout), {});
});

// ---------------------------------------------------------------- Node.js missing or too old

const HOOKS = JSON.parse(readFileSync(join(REPO, "hooks/hooks.json"), "utf8")).hooks;
const SESSION_START = HOOKS.SessionStart[0].hooks[0].command;
const PRE_TOOL_USE = HOOKS.PreToolUse[0].hooks[0].command;
const NODE_NOTE = /Node\.js 20 or newer.*https:\/\/nodejs\.org/;
const GIT = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

/** A PATH folder holding git and a `node` that is missing, broken, or the
 *  real one reporting another version. */
function fakeBin(t, node) {
  const bin = tmpDir(t);
  symlinkSync(GIT, join(bin, "git"));
  if (node === "missing") return bin;
  const exe = join(bin, "node");
  if (node === "broken") writeFileSync(exe, "#!/bin/sh\necho 'SyntaxError: Unexpected token' >&2\nexit 1\n");
  else {
    const pre = join(bin, "fake-version.mjs");
    writeFileSync(pre, `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(node)} });\n`);
    writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" --import "${pathToFileURL(pre).href}" "$@"\n`);
  }
  chmodSync(exe, 0o755);
  return bin;
}

/** Run a hooks.json command the way Claude Code does on macOS and Linux. */
const runHook = (command, bin, input = "", shell = "/bin/sh") =>
  spawnSync(shell, ["-c", command], {
    input, encoding: "utf8", env: { HOME: bin, PATH: bin, CLAUDE_PLUGIN_ROOT: REPO, GIT_CONFIG_NOSYSTEM: "1" },
  });

const contextOf = (r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

test("hooks without node: SessionStart tells Claude, PreToolUse allows", (t) => {
  const { dev } = setup(t);
  const bin = fakeBin(t, "missing");
  const start = runHook(SESSION_START, bin, JSON.stringify({ cwd: dev }));
  assert.equal(start.status, 0, start.stderr);
  assert.match(contextOf(start), NODE_NOTE);
  const pre = runHook(PRE_TOOL_USE, bin, pushEvent(dev));
  assert.deepEqual([pre.status, pre.stdout, pre.stderr], [0, "", ""]);
  // The project-level hook that install writes for teammates without the plugin.
  const settings = JSON.parse(readFileSync(join(dev, ".claude/settings.json"), "utf8"));
  const project = spawnSync("/bin/sh", ["-c", settings.hooks.PreToolUse[0].hooks[0].command], {
    input: pushEvent(dev), encoding: "utf8", env: { PATH: bin, CLAUDE_PROJECT_DIR: dev },
  });
  assert.deepEqual([project.status, project.stdout, project.stderr], [0, "", ""]);
});

test("hooks with a node that can't run the gate: a note, never exit 2", (t) => {
  const { dev } = setup(t);
  const bin = fakeBin(t, "broken");
  const start = runHook(SESSION_START, bin, JSON.stringify({ cwd: dev }));
  assert.equal(start.status, 0, start.stderr);
  assert.match(contextOf(start), NODE_NOTE);
  assert.notEqual(runHook(PRE_TOOL_USE, bin, pushEvent(dev)).status, 2);
});

test("session start on Node older than 20 adds the note; 20+ doesn't", (t) => {
  const { dev } = setup(t);
  const old = runHook(SESSION_START, fakeBin(t, "18.20.4"), JSON.stringify({ cwd: dev }));
  assert.equal(old.status, 0, old.stderr);
  assert.match(contextOf(old), NODE_NOTE);
  assert.match(contextOf(old), /18\.20\.4/);
  assert.match(contextOf(old), /ownership gate/);                  // the rest still works
  const current = runHook(SESSION_START, fakeBin(t, "20.0.0"), JSON.stringify({ cwd: dev }));
  assert.doesNotMatch(contextOf(current), NODE_NOTE);
});

test("hook commands are valid in every POSIX shell here and exit 0 without node", (t) => {
  const bin = fakeBin(t, "missing");
  const shells = ["/bin/sh", "/bin/bash", "/bin/dash", "/bin/zsh", "/usr/bin/dash"].filter((s) => existsSync(s));
  for (const shell of shells) {
    for (const command of [SESSION_START, PRE_TOOL_USE]) {
      assert.equal(spawnSync(shell, ["-n", "-c", command]).status, 0, `${shell} can't parse: ${command}`);
      assert.equal(runHook(command, bin, "{}", shell).status, 0, `${shell}: ${command}`);
    }
  }
});

// ---------------------------------------------------------------- plugin PreToolUse hook

const pushEvent = (cwd) => JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd });

test("plugin hook never executes repo code", (t) => {
  const { dev, tmp } = setup(t);
  unlinkSync(join(dev, ".claude/settings.json"));            // repo without the project-level hook
  const marker = join(tmp, "PWNED");
  writeFileSync(join(dev, REPO_GATE), codeWriteMarker(marker));
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked + a malicious gate.py");
  const r = plugin(tmp, ["claude-hook", "--from-plugin"], { input: pushEvent(dev) });
  assert.ok(!existsSync(marker));                            // the repo's code never ran
  assert.ok(r.status === 2 && r.stderr.includes("No ownership report"));   // the plugin's own logic still blocks
  const npm = JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" }, cwd: dev });
  assert.equal(plugin(tmp, ["claude-hook", "--from-plugin"], { input: npm }).status, 0);
});

test("session start never auto installs a hook for unknown gate code", (t) => {
  const { dev, tmp } = setup(t);
  unlinkSync(join(dev, ".git/hooks/pre-push"));
  writeFileSync(join(dev, REPO_GATE), "something else entirely\n");
  const out = JSON.parse(plugin(tmp, ["session-start"], { input: JSON.stringify({ cwd: dev }) }).stdout);
  assert.ok(!existsSync(join(dev, ".git/hooks/pre-push")));
  assert.ok(out.hookSpecificOutput.additionalContext.includes("NOT installed automatically"));
});

test("plugin hook steps aside when project hook exists", (t) => {
  const { dev, tmp } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked");
  // project settings already run the gate: the plugin copy must not double-run
  assert.equal(plugin(tmp, ["claude-hook", "--from-plugin"], { input: pushEvent(dev) }).status, 0);
  assert.equal(runGate(dev, ["claude-hook"], { input: pushEvent(dev) }).status, 2);
});

test("plugin hook falls back to itself without a repo gate", (t) => {
  const { dev, tmp } = setup(t);
  unlinkSync(join(dev, ".claude/settings.json"));
  unlinkSync(join(dev, REPO_GATE));
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked");
  const r = plugin(tmp, ["claude-hook", "--from-plugin"], { input: pushEvent(dev) });
  assert.ok(r.status === 2 && r.stderr.includes("No ownership report"));
});

// ---------------------------------------------------------------- CI job summary

test("job summary for reviewers", (t) => {
  const { dev, tmp } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  write(dev, "src/auth/login.js", "export function login(u) { return u; }\n");
  gate.save({
    summary: SUMMARY + " <script>alert(1)</script> ![x](https://evil.example/p.png)",
    verified: { "src/app.js": ["limit math"], "src/auth/login.js": ["token check <b>"] },
  }, dev);
  commitAll(dev, "with report");
  const summaryFile = join(tmp, "summary.md");
  const env = { ...ENV, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summaryFile };
  const r = runGate(dev, ["verify"], { env });
  assert.equal(r.status, 0);
  const md = readFileSync(summaryFile, "utf8");
  assert.ok(md.startsWith("## ✅ Ownership check passed"));
  assert.ok(md.includes("### The developer's summary") && md.includes("### Verified understanding"));
  assert.ok(md.includes("| src/auth/login.js 🔒 | token check &lt;b&gt; |"));
  assert.ok(!md.includes("<script>") && md.includes("&lt;script&gt;") && !md.includes("![x]"));
  assert.ok(md.includes("never scores or mistakes"));
});

test("job summary on failure", (t) => {
  const { dev, tmp } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "no report");
  const summaryFile = join(tmp, "summary.md");
  const env = { ...ENV, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summaryFile };
  assert.equal(runGate(dev, ["verify"], { env }).status, 1);
  const md = readFileSync(summaryFile, "utf8");
  assert.ok(md.startsWith("## ❌ Ownership check failed") && md.includes("No ownership report"));
});

// ---------------------------------------------------------------- protect (with a fake gh)

const FAKE_GH = `#!${process.execPath}
const fs = require("fs");
const log = process.env.FAKE_GH_LOG;
const mode = process.env.FAKE_GH_MODE || "ok";
const args = process.argv.slice(2);
const body = args.includes("--input") ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(log, JSON.stringify({ args, body }) + "\\n");
function main() {
  if (args[0] === "repo" && args[1] === "view") {
    process.stdout.write("acme/shop-api\\n"); return 0;
  }
  if (args[0] === "api" && args[1] === "repos/acme/shop-api/rulesets") {
    process.stdout.write(JSON.stringify(mode === "exists" ? [{ id: 7, name: "Ownership gate" }] : []) + "\\n"); return 0;
  }
  if (args.includes("-X") && args.includes("POST")) {
    if (mode === "forbidden") {
      process.stderr.write("gh: Must have admin rights to Repository. (HTTP 403)\\n"); return 1;
    }
    if (mode === "free-private") {
      process.stderr.write("gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)\\n");
      return 1;
    }
    process.stdout.write(JSON.stringify({ id: 42 }) + "\\n"); return 0;
  }
  return 1;
}
process.exitCode = main();
`;

/** Fixture: a fake `gh` on PATH that logs its calls. Returns the env to pass
 *  to the gate (instead of monkeypatching os.environ) and a log reader. */
function fakeGh(dir, mode) {
  const bindir = join(dir, "fakebin");
  mkdirSync(bindir);
  const gh = join(bindir, "gh");
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);
  const log = join(dir, "gh.log");
  const env = { ...ENV, PATH: `${bindir}${delimiter}${ENV.PATH}`, FAKE_GH_LOG: log };
  if (mode) env.FAKE_GH_MODE = mode;
  const calls = () => existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l))
    : [];
  return { env, calls };
}

test("protect dry run changes nothing", (t) => {
  const { dev, tmp } = setup(t);
  const gh = fakeGh(tmp);
  const out = gate.protect(dev, { approvals: 1 }, gh.env);   // Python's default approvals=1
  assert.ok(out.some((l) => l.includes("Dry run")));
  const last = out[out.length - 1];
  assert.ok(last.includes('"context": "Ownership check"') && last.includes("~DEFAULT_BRANCH"));
  assert.ok(!gh.calls().some((c) => c.args.includes("POST")));
});

test("protect apply creates the ruleset", (t) => {
  const { dev, tmp } = setup(t);
  const gh = fakeGh(tmp);
  const out = gate.protect(dev, { apply: true, approvals: 2 }, gh.env);
  assert.equal(out[out.length - 1], "Created: https://github.com/acme/shop-api/rules/42");
  const post = gh.calls().filter((c) => c.args.includes("POST"))[0];
  const body = JSON.parse(post.body);
  assert.deepEqual(post.args.slice(0, 4), ["api", "-X", "POST", "repos/acme/shop-api/rulesets"]);
  const rules = Object.fromEntries(body.rules.map((r) => [r.type, r.parameters]));
  assert.equal(rules.pull_request.required_approving_review_count, 2);
  assert.equal(rules.pull_request.require_code_owner_review, true);
  assert.deepEqual(rules.required_status_checks.required_status_checks, [{ context: "Ownership check" }]);
});

// Parametrized: (mode, match). Python uses gate.protect's default approvals=1;
// the JS helper omits --approvals when unset, so pass 1 explicitly to match.
for (const [mode, match] of [["exists", "already exists"], ["forbidden", "admin"], ["free-private", "free plan"]]) {
  test(`protect edge cases [${mode}-${match}]`, (t) => {
    const { dev, tmp } = setup(t);
    const gh = fakeGh(tmp, mode);
    if (mode === "exists") {
      assert.ok(gate.protect(dev, { apply: true, approvals: 1 }, gh.env)[0].includes(match));
      assert.ok(!gh.calls().some((c) => c.args.includes("POST")));
    } else {
      throwsGate(() => gate.protect(dev, { apply: true, approvals: 1 }, gh.env), new RegExp(match));
    }
  });
}

/** shutil.which equivalent over ENV.PATH. */
function which(cmd) {
  for (const d of (ENV.PATH ?? "").split(delimiter)) {
    if (!d) continue;
    const p = join(d, cmd);
    try {
      if (statSync(p).isFile()) { accessSync(p, constants.X_OK); return p; }
    } catch { /* keep looking */ }
  }
  throw new Error(`${cmd} not found on PATH`);
}

test("protect without gh", (t) => {
  const { dev, tmp } = setup(t);
  const onlyGit = join(tmp, "only-git");
  mkdirSync(onlyGit);
  symlinkSync(which("git"), join(onlyGit, "git"));
  // gateCli runs process.execPath directly, so node itself is still found.
  throwsGate(() => gate.protect(dev, { approvals: 1 }, { ...ENV, PATH: onlyGit }), /GitHub CLI/);
});

test("workflow job name matches required check", () => {
  const wf = parseYaml(gate.const("WORKFLOW"));
  assert.equal(wf.jobs.ownership.name, gate.const("CHECK_NAME"));
});
