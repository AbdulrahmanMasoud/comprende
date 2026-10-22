// Port of mcp/tests/test_security_plugin.py.
// Regression tests for the security review of the plugin layer. The threat:
// a malicious repo the user clones and opens with the plugin installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ENV, GATE, NODE, REPO_GATE, callTool, commitAll, gate, git, runGate, setup, sh, throwsGate, write } from "./helpers.mjs";

// Same as gateCli(), plus the timeout the Python plugin() takes (gateCli has none).
const plugin = (cwd, args, { input = "", env, timeout = 60_000 } = {}) =>
  sh(cwd, NODE, [GATE, ...args], { check: false, input, env: env ?? ENV, timeout });

function sessionStart(dev, dir, env) {
  const out = plugin(dir, ["session-start"], { input: JSON.stringify({ cwd: dev }), env }).stdout;
  return JSON.parse(out).hookSpecificOutput?.additionalContext ?? "";
}

const push = (dev) => sh(dev, "git", ["push", "-u", "origin", "HEAD:refs/heads/feature/x"], { check: false });

// JS equivalents of impl.py's node snippets.
const codeWriteMarker = (marker) => `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'x');\n`;

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

// F1: a module planted next to gate.py must never be imported by the hook.
test("planted stdlib module never runs on push", (t) => {
  const { dev, tmp } = setup(t);
  const marker = join(tmp, "PWNED-1");
  plantShadowModules(dev, marker);
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "plant modules");
  unlinkSync(join(dev, ".git/hooks/pre-push"));
  sessionStart(dev, tmp);                                         // auto-installs the pinned hook
  const r = push(dev);
  assert.ok(!existsSync(marker));
  assert.ok(r.status !== 0 && r.stderr.includes("No ownership report"));   // the gate itself still worked
});

// F2: gate.py swapped after the hook was installed is not executed.
test("gate swapped after install is not executed", (t) => {
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

test("session start repins only for trusted code", (t) => {
  const { dev, tmp } = setup(t);
  const hook = join(dev, ".git/hooks/pre-push");
  const before = readFileSync(hook, "utf8");
  writeFileSync(join(dev, REPO_GATE), "something different\n");
  assert.ok(sessionStart(dev, tmp).includes("NOT installed automatically"));
  assert.equal(readFileSync(hook, "utf8"), before);               // still pinned to the trusted copy
});

// F3: a global/shared core.hooksPath is never written to automatically.
test("shared hooks path is never touched", (t) => {
  const { dev, tmp } = setup(t);
  const shared = join(tmp, "global-hooks");
  mkdirSync(shared);
  git(dev, "config", "core.hooksPath", shared);
  const ctx = sessionStart(dev, tmp);
  assert.ok(!existsSync(join(shared, "pre-push")) && ctx.includes("core.hooksPath is set"));
  const out = gate.installHooks(dev)[0];                          // explicit, but shared dir: refuse
  assert.ok(out.startsWith("SKIPPED") && out.includes("outside this repo") && !existsSync(join(shared, "pre-push")));
  git(dev, "config", "core.hooksPath", ".husky");                 // repo-local custom dir: allowed explicitly
  assert.ok(gate.installHooks(dev)[0].startsWith("installed") && existsSync(join(dev, ".husky/pre-push")));
});

// F4: hostile config files can't hang or exhaust a session.
for (const kind of ["devzero", "huge", "fifo"]) {
  test(`hostile config cannot hang session start [${kind}]`, (t) => {
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
    assert.deepEqual(JSON.parse(r.stdout), {});
    assert.ok(Date.now() - start < 10_000, `took ${Date.now() - start}ms`);
    throwsGate(() => gate.status(dev));
  });
}

test("symlinked report and settings are not followed", (t) => {
  const { dev } = setup(t);
  const rel = join(dev, gate.reportRelpath("feature/rate-limit"));
  mkdirSync(dirname(rel), { recursive: true });
  symlinkSync("/dev/zero", rel);
  write(dev, "src/app.js", "export const app = 2;\n");
  const st = gate.status(dev);                                    // lenient: notes it, doesn't read it
  assert.ok(st.notes.some((n) => n.includes("symlink")));
  unlinkSync(join(dev, ".claude/settings.json"));
  symlinkSync("/dev/zero", join(dev, ".claude/settings.json"));
  assert.ok(gate.mergeClaudeSettings(join(dev, ".claude/settings.json")).includes("SKIPPED"));
});

// F5: commands from the repo's own .git/config never run while reading changes.
test("repo local filter commands are refused", (t) => {
  const { dev, tmp } = setup(t);
  const marker = join(tmp, "PWNED-5");
  git(dev, "config", "filter.evil.clean", `sh -c 'touch ${marker}; cat'`);
  write(dev, ".gitattributes", "*.js filter=evil\n");
  write(dev, "src/app.js", "export const app = 2;\n");
  throwsGate(() => gate.status(dev), /filter commands/);
  assert.throws(() => callTool("gate_status", { repo_root: dev, base: "", branch: "" }), /filter commands/);
  assert.ok(!existsSync(marker));
  const trusted = { ...ENV, OWNERSHIP_GATE_TRUST_REPO_CONFIG: "1" };
  assert.equal(runGate(dev, ["status"], { env: trusted }).status, 0);   // explicit trust: the user's own setup
});

test("repo local fsmonitor command never runs", (t) => {
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

test("global filters like lfs still work", (t) => {
  const { dev, tmp } = setup(t);
  const gcfg = join(tmp, "gitconfig");
  writeFileSync(gcfg, '[filter "upper"]\n\tclean = tr a-z A-Z\n\tsmudge = cat\n');
  const env = { ...ENV, GIT_CONFIG_GLOBAL: gcfg };
  write(dev, ".gitattributes", "*.txt filter=upper\n");
  write(dev, "notes.txt", "hello\n");
  const r = runGate(dev, ["status"], { env });
  assert.ok(r.status === 0 && r.stdout.includes("notes.txt"));
});

// F6: no links, images, HTML, code spans or table breaks from PR authors.
test("job summary neutralises author markdown", () => {
  const s = gate.mdSafe("[click](https://evil.example) ![i](x) <b>|x| `code` **bold**");
  for (const bad of ["[click](", "![i]", "<b>", "|x|", "`code`", "**bold**"]) {
    assert.ok(!s.includes(bad), bad);
  }
});
