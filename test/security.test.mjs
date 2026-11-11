// The plugin in repos you don't trust: no repo code runs, nothing is followed out of the repo,
// and nothing from the environment changes what the gate does.

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  callTool,
  commitAll,
  ENV,
  gate,
  gateCli,
  git,
  plugin,
  pushEvent,
  REPO,
  REPO_GATE,
  runGate,
  setup,
  sh,
  throwsGate,
  tmp,
  write,
} from "./helpers.mjs";

// Gate code that would leave a marker file if it ever ran.
const codeWriteMarker = (marker) => `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'x');\n`;

function sessionStart(dev, dir, env) {
  const out = plugin(dir, ["session-start"], { input: JSON.stringify({ cwd: dev }), env }).stdout;
  return JSON.parse(out).hookSpecificOutput?.additionalContext ?? "";
}

const push = (dev) => sh(dev, "git", ["push", "-u", "origin", "HEAD:refs/heads/feature/x"], { check: false });

function plantShadowModules(root, marker) {
  for (const d of [join(root, ".learning"), root]) {
    for (const mod of ["fs", "crypto", "child_process", "path", "os"]) {
      const pkg = join(d, "node_modules", mod);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: mod, main: "index.js" }));
      writeFileSync(join(pkg, "index.js"), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
    }
    writeFileSync(join(d, "package.json"), JSON.stringify({ type: "module", imports: { "#x": "./x.js" } }));
  }
}

test("the plugin's hook never runs the repo's own gate code", (t) => {
  const { dev, tmp } = setup(t);
  unlinkSync(join(dev, ".claude/settings.json")); // repo without the project-level hook
  const marker = join(tmp, "PWNED");
  writeFileSync(join(dev, REPO_GATE), codeWriteMarker(marker));
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked + a malicious gate.mjs");
  const r = plugin(tmp, ["claude-hook", "--from-plugin"], { input: pushEvent(dev) });
  assert.ok(!existsSync(marker)); // the repo's code never ran
  assert.ok(r.status === 2 && r.stderr.includes("No ownership report")); // the plugin's own logic still blocks
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

test("session start repins only for trusted code", (t) => {
  const { dev, tmp } = setup(t);
  const hook = join(dev, ".git/hooks/pre-push");
  const before = readFileSync(hook, "utf8");
  writeFileSync(join(dev, REPO_GATE), "something different\n");
  assert.ok(sessionStart(dev, tmp).includes("NOT installed automatically"));
  assert.equal(readFileSync(hook, "utf8"), before); // still pinned to the trusted copy
});

// a module planted next to gate.mjs must never be imported by the hook.
test("a module planted next to gate.mjs never runs on push", (t) => {
  const { dev, tmp } = setup(t);
  const marker = join(tmp, "PWNED-1");
  plantShadowModules(dev, marker);
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "plant modules");
  unlinkSync(join(dev, ".git/hooks/pre-push"));
  sessionStart(dev, tmp); // auto-installs the pinned hook
  const r = push(dev);
  assert.ok(!existsSync(marker));
  assert.ok(r.status !== 0 && r.stderr.includes("No ownership report")); // the gate itself still worked
});

// gate.mjs swapped after the hook was installed is not executed.
test("a gate.mjs swapped after install is not executed", (t) => {
  const { dev, tmp } = setup(t);
  const marker = join(tmp, "PWNED-2");
  writeFileSync(join(dev, REPO_GATE), codeWriteMarker(marker));
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "swap the gate");
  const r = push(dev);
  assert.ok(!existsSync(marker));
  assert.ok(r.stderr.includes("changed since this hook was installed"));
  // explicitly re-trusting re-pins (the user's decision, not automatic)
  assert.ok(!gate.installHooks(dev)[0].includes("SKIPPED"));
});

// NODE_OPTIONS / NODE_PATH from the environment can't inject code into the pinned hook.
test("the pinned pre-push hook ignores NODE_OPTIONS and NODE_PATH", (t) => {
  const { dev } = setup(t);
  const dir = tmp(t);
  const marker = join(dir, "PWNED");
  const evil = join(dir, "evil.cjs");
  writeFileSync(evil, `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`);
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked");
  const env = { ...ENV, NODE_OPTIONS: `--require ${evil}`, NODE_PATH: dir };
  const r = sh(dev, "git", ["push", "-u", "origin", "feature/rate-limit"], { check: false, env });
  assert.equal(existsSync(marker), false, "NODE_OPTIONS code ran inside the hook");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No ownership report/);
});

// a global/shared core.hooksPath is never written to automatically.
test("a shared core.hooksPath is never touched", (t) => {
  const { dev, tmp } = setup(t);
  const shared = join(tmp, "global-hooks");
  mkdirSync(shared);
  git(dev, "config", "core.hooksPath", shared);
  const ctx = sessionStart(dev, tmp);
  assert.ok(!existsSync(join(shared, "pre-push")) && ctx.includes("core.hooksPath is set"));
  const out = gate.installHooks(dev)[0]; // explicit, but shared dir: refuse
  assert.ok(out.startsWith("SKIPPED") && out.includes("outside this repo") && !existsSync(join(shared, "pre-push")));
  git(dev, "config", "core.hooksPath", ".husky"); // repo-local custom dir: allowed explicitly
  assert.ok(gate.installHooks(dev)[0].startsWith("installed") && existsSync(join(dev, ".husky/pre-push")));
});

// core.hooksPath that is a symlink to a shared folder is never written to.
test("a hooksPath symlinked out of the repo is refused", (t) => {
  const { dev, tmp: dir } = setup(t);
  const shared = join(dir, "shared-hooks");
  mkdirSync(shared);
  symlinkSync(shared, join(dev, "myhooks"));
  git(dev, "config", "core.hooksPath", "myhooks");
  const out = gate.installHooks(dev)[0];
  assert.match(out, /^SKIPPED.*outside this repo/);
  assert.equal(existsSync(join(shared, "pre-push")), false);
  // ...but a real folder whose name starts with ".." is inside the repo
  mkdirSync(join(dev, "..hooks"));
  git(dev, "config", "core.hooksPath", "..hooks");
  assert.match(gate.installHooks(dev)[0], /^installed/);
});

// hostile config files can't hang or exhaust a session.
for (const kind of ["devzero", "huge", "fifo"]) {
  test(`a hostile config can't hang session start [${kind}]`, (t) => {
    const { dev, tmp } = setup(t);
    const cfg = join(dev, ".learning/config.json");
    unlinkSync(cfg);
    if (kind === "devzero") {
      symlinkSync("/dev/zero", cfg);
    } else if (kind === "huge") {
      writeFileSync(cfg, '{"ownership_check": {"mode": "required", "x": "' + "a".repeat(2_000_000) + '"}}');
    } else {
      sh(tmp, "mkfifo", [cfg]);
    }
    const start = Date.now();
    const r = plugin(tmp, ["session-start"], { input: JSON.stringify({ cwd: dev }), timeout: 20_000 });
    assert.equal(r.status, 0);
    // The gate part is skipped; only the fixed always-on line remains.
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, gate.const("ALWAYS_ON"));
    assert.ok(Date.now() - start < 10_000, `took ${Date.now() - start}ms`);
    throwsGate(() => gate.status(dev));
  });
}

test("a symlinked report or settings file is not followed", (t) => {
  const { dev } = setup(t);
  const rel = join(dev, gate.reportRelpath("feature/rate-limit"));
  mkdirSync(dirname(rel), { recursive: true });
  symlinkSync("/dev/zero", rel);
  write(dev, "src/app.js", "export const app = 2;\n");
  const st = gate.status(dev); // lenient: notes it, doesn't read it
  assert.ok(st.notes.some((n) => n.includes("symlink")));
  unlinkSync(join(dev, ".claude/settings.json"));
  symlinkSync("/dev/zero", join(dev, ".claude/settings.json"));
  assert.ok(gate.mergeClaudeSettings(join(dev, ".claude/settings.json")).includes("SKIPPED"));
});

// commands from the repo's own .git/config never run while reading changes.
test("filter commands from the repo's own git config are refused", (t) => {
  const { dev, tmp } = setup(t);
  const marker = join(tmp, "PWNED-5");
  git(dev, "config", "filter.evil.clean", `sh -c 'touch ${marker}; cat'`);
  write(dev, ".gitattributes", "*.js filter=evil\n");
  write(dev, "src/app.js", "export const app = 2;\n");
  throwsGate(() => gate.status(dev), /filter commands/);
  assert.throws(() => callTool("gate_status", { repo_root: dev, base: "", branch: "" }), /filter commands/);
  assert.ok(!existsSync(marker));
  const trusted = { ...ENV, OWNERSHIP_GATE_TRUST_REPO_CONFIG: "1" };
  assert.equal(runGate(dev, ["status"], { env: trusted }).status, 0); // explicit trust: the user's own setup
});

test("an fsmonitor command from the repo's own git config never runs", (t) => {
  const { dev, tmp } = setup(t);
  const marker = join(tmp, "PWNED-fsmonitor");
  const script = join(tmp, "fsm.sh");
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(script, 0o755);
  git(dev, "config", "core.fsmonitor", script);
  write(dev, "src/app.js", "export const app = 2;\n");
  gate.status(dev);
  assert.ok(!existsSync(marker));
});

test("global filters such as git-lfs still work", (t) => {
  const { dev, tmp } = setup(t);
  const gcfg = join(tmp, "gitconfig");
  writeFileSync(gcfg, '[filter "upper"]\n\tclean = tr a-z A-Z\n\tsmudge = cat\n');
  const env = { ...ENV, GIT_CONFIG_GLOBAL: gcfg };
  write(dev, ".gitattributes", "*.txt filter=upper\n");
  write(dev, "notes.txt", "hello\n");
  const r = runGate(dev, ["status"], { env });
  assert.ok(r.status === 0 && r.stdout.includes("notes.txt"));
});

test("an option can't swallow the next option as its value", (t) => {
  const { dev } = setup(t);
  const r = gateCli(["status", "--repo", dev, "--base", "--branch", "x"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--base needs a value/);
  assert.equal(gateCli(["status", "--repo", dev, "stray"]).status, 2);
  const empty = gateCli(["protect", "--repo", dev, "--approvals", ""]);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /--approvals must be between 0 and 10/);
});

// Claims (src/gate/hook-claims.ts) live under the system temp folder, which on
// Linux every user shares. TMPDIR points each test at its own.
const CURSOR_FIXTURES = join(REPO, "test/fixtures/cursor");
const cursorEnv = (tmpdir) => ({
  ...ENV,
  ...JSON.parse(readFileSync(join(CURSOR_FIXTURES, "hook-env.json"), "utf8")),
  TMPDIR: tmpdir,
  OWNERSHIP_GATE_NO_AUTO_HOOK: "1",
});
const cursorPayload = (name, dev, fields) =>
  JSON.stringify({
    ...JSON.parse(readFileSync(join(CURSOR_FIXTURES, name), "utf8")),
    workspace_roots: [dev],
    ...fields,
  });
const claimsFolderIn = (tmpdir) => join(tmpdir, `comprende-hook-runs-${process.getuid?.()}`);

test("a claims folder that's a symlink or that others can read isn't used: every copy checks", {
  skip: process.platform === "win32",
}, (t) => {
  const { dev, tmp: dir } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked");
  unlinkSync(join(dev, ".claude/settings.json"));
  unlinkSync(join(dev, ".cursor/hooks.json"));
  const tmpdir = join(dir, "tmp");
  const folder = claimsFolderIn(tmpdir);
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(elsewhere, { mode: 0o700 });
  mkdirSync(tmpdir);
  const setups = {
    "a symlink to a private folder": () => symlinkSync(elsewhere, folder),
    "readable by others": () => {
      mkdirSync(folder);
      chmodSync(folder, 0o755);
    },
  };
  let call = 0;
  for (const [name, makeFolder] of Object.entries(setups)) {
    rmSync(folder, { recursive: true, force: true });
    makeFolder();
    const input = cursorPayload("pre-tool-use.shell.git-push.json", dev, { tool_use_id: `call-${++call}` });
    const statuses = [1, 2].map(
      () =>
        plugin(REPO, ["agent-hook", "--from-plugin", "--agent", "cursor"], { input, env: cursorEnv(tmpdir) }).status,
    );
    assert.deepEqual(statuses, [2, 2], name);
  }
  assert.deepEqual(readdirSync(elsewhere), []);
});

test("pruning old claims deletes only claim files", { skip: process.platform === "win32" }, (t) => {
  const dir = tmp(t);
  const folder = claimsFolderIn(dir);
  mkdirSync(folder, { mode: 0o700 });
  const hour = Date.now() / 1000 - 3600;
  const oldClaim = join(folder, "a".repeat(64));
  const freshClaim = join(folder, "b".repeat(64));
  const notAClaim = join(folder, "notes.txt");
  for (const path of [oldClaim, freshClaim, notAClaim]) writeFileSync(path, "");
  utimesSync(oldClaim, hour, hour);
  utimesSync(notAClaim, hour, hour);
  plugin(REPO, ["session-start", "--from-plugin", "--agent", "cursor"], {
    input: cursorPayload("session-start.json", dir, { session_id: "session-prune" }),
    env: cursorEnv(dir),
  });
  assert.deepEqual([existsSync(oldClaim), existsSync(freshClaim), existsSync(notAClaim)], [false, true, true]);
});

test("a session start from the repo's own hook file never installs the git hook, even for a changed gate.mjs", (t) => {
  const { dev, tmp: dir } = setup(t);
  const hook = join(dev, ".git/hooks/pre-push");
  rmSync(hook, { force: true });
  // Run from the repo's hook file, the repo's gate.mjs would compare itself with itself.
  writeFileSync(join(dev, REPO_GATE), `${readFileSync(join(dev, REPO_GATE), "utf8")}// changed\n`);
  const r = runGate(dev, ["session-start", "--from-repo", "--agent", "cursor"], {
    input: cursorPayload("session-start.json", dev, { session_id: "session-repo-run" }),
    env: { ...cursorEnv(dir), OWNERSHIP_GATE_NO_AUTO_HOOK: "" },
  });
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /This repository uses the ownership gate/);
  assert.ok(!existsSync(hook), "the repo's gate installed a git hook pinned to itself");
});
