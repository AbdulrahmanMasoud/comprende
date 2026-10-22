// Regression tests for the fifth review: divergences introduced by the
// Python → TypeScript port. Each would have failed before the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENV, NODE, SUMMARY, commitAll, gate, gateCli, git, gitTry, payload, saveAndCommit, setup, sh, throwsGate, tmp, write,
} from "./helpers.mjs";

const setBaseConfig = (dev, mutate) => {
  git(dev, "checkout", "-q", "main");
  const p = join(dev, ".learning/config.json");
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  mutate(cfg.ownership_check);
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  commitAll(dev, "config change on main");
  git(dev, "push", "-q", "origin", "main");
  git(dev, "checkout", "-q", "feature/rate-limit");
  git(dev, "merge", "-q", "--no-edit", "main");
};

// 1. File paths are map keys: "__proto__" and friends must be ordinary files.
for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
  test(`a file named ${name} is a change like any other`, (t) => {
    const { dev } = setup(t);
    write(dev, name, "anything\n");
    commitAll(dev, `add ${name}`);
    const [changes] = gate.collectChanges(dev, "origin/main", "HEAD");
    assert.ok(Object.hasOwn(changes, name), `${name} missing from changes`);
    const [passed, problems] = gate.verify(dev);
    assert.equal(passed, false);
    assert.match(problems[0], /No ownership report/);
  });
}

test("a submodule named __proto__ is still sensitive and still checked", (t) => {
  const { dev, tmp: dir } = setup(t);
  const lib = join(dir, "lib");
  git(dir, "init", "-q", "-b", "main", lib);
  write(lib, "x.txt", "1\n");
  commitAll(lib, "x");
  git(dev, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "__proto__");
  write(dev, "src/app.js", "export const app = 2;\n");
  assert.ok(gate.status(dev).must_verify.includes("__proto__"));
  throwsGate(() => gate.save(payload({ "src/app.js": ["x"] }), dev), /__proto__/);
});

test("a sensitive file named constructor must be explicitly verified", (t) => {
  const { dev } = setup(t);
  setBaseConfig(dev, (c) => c.sensitive.push("constructor"));
  write(dev, "constructor", "x\n");
  write(dev, "src/app.js", "export const app = 2;\n");
  throwsGate(() => gate.save(payload({ "src/app.js": ["x"] }), dev), /constructor/);
  saveAndCommit(dev, { "src/app.js": ["x"], constructor: ["what it does"] });
  assert.equal(gate.verify(dev)[0], true);
});

test("verifying a path that isn't in the change is refused, even toString", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  throwsGate(() => gate.save(payload({ "src/app.js": ["x"], toString: ["sneaky"] }), dev), /Not part of this change: toString/);
});

// 2 & 3. Globs behave like Python's fnmatch and never crash.
test("a reversed range in a config glob doesn't crash, and doesn't open the gate", (t) => {
  const { dev } = setup(t);
  setBaseConfig(dev, (c) => c.sensitive.push("[z-a]"));
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked");
  const [passed] = gate.verify(dev);
  assert.equal(passed, false);
  const r = gitTry(dev, "push", "-u", "origin", "feature/rate-limit");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Ownership gate blocked/);
});

test("glob edge cases match Python's fnmatch", () => {
  const cases = [
    ["a", "[]a]", true], ["]", "[]a]", true], ["b", "[]a]", false],
    ["b", "[!]]", true], ["]", "[!]]", false],
    ["a😀b", "a?b", true], ["a😀😀b", "a?b", false],
    ["x-y", "x[-]y", true], ["d", "[a-c-e]", false], ["e", "[a-c-e]", true],
    ["web/package-lock.json", "**/package-lock.json", true], ["package-lock.json", "**/package-lock.json", true],
    ["a.b+c(d)", "a.b+c(d)", true], ["axb+c(d)", "a.b+c(d)", false],
    ["anything", "[z-a]*", false], ["q", "[!z-a]", true],
  ];
  for (const [path, pat, want] of cases) {
    // None of these patterns can match path + "/_", which is_sensitive also tries.
    assert.equal(gate.isSensitive(path, "100644", { sensitive: [pat] }), want, `${pat} vs ${path}`);
  }
});

// 5. core.hooksPath that is a symlink to a shared folder is never written to.
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

// 6. The summary is measured like Python: code points, Python whitespace.
test("summary length counts characters, not UTF-16 units or exotic whitespace", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  throwsGate(() => gate.save({ summary: "😀".repeat(40), verified: { "src/app.js": ["x"] } }, dev), /at least 80 characters/);
  throwsGate(() => gate.save({ summary: "ok" + "\x1c".repeat(80), verified: { "src/app.js": ["x"] } }, dev), /at least 80 characters/);
  gate.save({ summary: "😀".repeat(80), verified: { "src/app.js": ["x"] } }, dev);
});

// 7. Config and arguments are as strict as the reference.
test("min_summary_chars must be an integer literal", (t) => {
  const { dev } = setup(t);
  for (const lit of ["80.0", "1e2"]) {
    const p = join(dev, ".learning/config.json");
    writeFileSync(p, readFileSync(p, "utf8").replace(/"min_summary_chars": [^,\n]+/, `"min_summary_chars": ${lit}`));
    throwsGate(() => gate.status(dev), /min_summary_chars/);
  }
});

test("only the gate's own min_summary_chars is checked for a float literal", (t) => {
  const { dev } = setup(t);
  const p = join(dev, ".learning/config.json");
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  writeFileSync(p, JSON.stringify({ ...cfg, notes: { min_summary_chars: 1.5 } }, null, 2));
  gate.status(dev);
  // A duplicate key: the last one wins, as JSON.parse reads it.
  writeFileSync(p, readFileSync(p, "utf8").replace('"min_summary_chars": 80', '"min_summary_chars": 1.5, "min_summary_chars": 80'));
  gate.status(dev);
});

test("glob ranges compare code points, not UTF-16 code units", () => {
  assert.equal(gate.isSensitive("😀", "100644", { sensitive: ["[-😀]"] }), true);
  // Reversed in code points, so empty (Python drops it) instead of a regex error.
  assert.equal(gate.isSensitive("😀", "100644", { sensitive: ["[😀-￿]"] }), false);
});

test("settings.json with hooks of the wrong shape is left untouched", (t) => {
  const p = join(tmp(t), "settings.json");
  for (const body of ['{"hooks": []}', '{"hooks": {"PreToolUse": {"matcher": "Bash"}}}']) {
    writeFileSync(p, body);
    assert.match(gate.mergeClaudeSettings(p), /SKIPPED/);
    assert.equal(readFileSync(p, "utf8"), body);
  }
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

// 8. Unicode spaces aren't shell word separators: no false "push" blocks.
test("push detection splits words on shell whitespace only", () => {
  assert.equal(gate.isPushCommand("git push"), false);
  assert.equal(gate.isPushCommand("git commit -m fix#1 && git push"), true);
  assert.equal(gate.isPushCommand("echo a#b; git push"), true);
  assert.equal(gate.isPushCommand("git push # later"), true);
});

// 9. NODE_OPTIONS / NODE_PATH from the environment can't inject code into the pinned hook.
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

test("the CI workflow clears NODE_OPTIONS for the gate step", () => {
  assert.match(gate.const("WORKFLOW"), /NODE_OPTIONS: ""/);
});

// Sanity: SUMMARY and NODE are what the other suites use.
test("helpers sanity", () => {
  assert.ok(SUMMARY.length >= 80);
  assert.ok(NODE);
});
