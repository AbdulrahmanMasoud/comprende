// The fast path for small changes: one question and a shorter summary.

import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitAll, gate, git, REPO_GATE, read, runGate, setup, sh, throwsGate, write } from "./helpers.mjs";

const SHORT = "Fixed the off-by-one in the greeting.";

// at least 30, under 80 characters

/** Edit main (its config or its gate), push it, and merge it into the feature branch. */
function onMain(dev, edit, msg) {
  git(dev, "checkout", "-q", "main");
  edit();
  commitAll(dev, msg);
  git(dev, "push", "-q", "--no-verify", "origin", "main");
  git(dev, "checkout", "-q", "feature/rate-limit");
  git(dev, "merge", "-q", "--no-edit", "main");
}

const editConfig = (dev, mutate) => {
  const cfg = JSON.parse(read(dev, ".learning/config.json"));
  mutate(cfg.ownership_check);
  writeFileSync(join(dev, ".learning/config.json"), JSON.stringify(cfg, null, 2) + "\n");
};

const smallOf = (dev) => {
  const st = gate.status(dev);
  return [st.small_change, st.changed_lines, st.min_summary_chars];
};

test("a small change needs only a short summary, and status says so", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\nexport const greeting = 'hi';\n"); // +2 -1
  assert.deepEqual(smallOf(dev), [true, 3, 30]);
  assert.match(runGate(dev, ["status"]).stdout, /Small change \(3 changed lines\): one question is enough/);
  throwsGate(() => gate.save({ summary: "typo", verified: { "src/app.js": ["x"] } }, dev), /at least 30 characters/);
  gate.save({ summary: SHORT, verified: { "src/app.js": ["why the greeting changed"] } }, dev);
  commitAll(dev, "small change + report");
  assert.deepEqual(gate.verify(dev), [true, [], "required"]);
  assert.match(read(dev, gate.reportRelpath("feature/rate-limit")), /"blob": "[0-9a-f]{40}"/); // still fingerprinted
  const push = sh(dev, "git", ["push", "-q", "-u", "origin", "feature/rate-limit"], { check: false });
  assert.equal(push.status, 0, push.stderr); // through the real pre-push hook
});

test("status and save count one line and one file in the singular", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 1;\nexport const b = 2;\n"); // +1
  assert.match(runGate(dev, ["status"]).stdout, /Small change \(1 changed line\):/);
  assert.match(
    gate.save({ summary: SHORT, verified: { "src/app.js": ["x"] } }, dev),
    /: 1 file fingerprinted, 1 verified\./,
  );
});

test("over small_change_lines, the full summary is required", (t) => {
  const { dev } = setup(t);
  write(dev, "src/new.js", Array.from({ length: 11 }, (_, i) => `export const n${i} = ${i};\n`).join(""));
  assert.deepEqual(smallOf(dev), [false, 11, 80]);
  throwsGate(() => gate.save({ summary: SHORT, verified: { "src/new.js": ["x"] } }, dev), /at least 80 characters/);
});

test("sensitive, binary and submodule changes are never small", (t) => {
  const { dev, tmp: dir } = setup(t);
  write(dev, "src/auth/login.js", "export function login() { return 1; }\n");
  assert.deepEqual(smallOf(dev), [false, null, 80]);
  git(dev, "checkout", "-q", "--", "src/auth/login.js");
  writeFileSync(join(dev, "src/logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  assert.deepEqual(smallOf(dev), [false, null, 80]);
  unlinkSync(join(dev, "src/logo.png"));
  const lib = join(dir, "lib");
  git(dir, "init", "-q", "-b", "main", lib);
  write(lib, "l.txt", "1\n");
  commitAll(lib, "l1");
  git(dev, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
  assert.deepEqual(smallOf(dev), [false, null, 80]);
});

test("ignored files don't count toward small_change_lines", (t) => {
  const { dev } = setup(t);
  write(dev, "package-lock.json", JSON.stringify({ deps: Array.from({ length: 50 }, (_, i) => i) }, null, 1));
  write(dev, "src/app.js", "export const app = 2;\n");
  assert.deepEqual(smallOf(dev), [true, 2, 30]);
});

test("small_change_lines: 0 turns the fast path off; the new keys are strict integers", (t) => {
  const { dev } = setup(t);
  onMain(
    dev,
    () =>
      editConfig(dev, (c) => {
        c.small_change_lines = 0;
      }),
    "fast path off",
  );
  write(dev, "src/app.js", "export const app = 2;\n");
  assert.deepEqual(smallOf(dev), [false, null, 80]);
  throwsGate(() => gate.save({ summary: SHORT, verified: { "src/app.js": ["x"] } }, dev), /at least 80 characters/);
  const p = join(dev, ".learning/config.json");
  const good = readFileSync(p, "utf8");
  for (const [key, bad] of [
    ["small_change_lines", '"10"'],
    ["small_change_lines", "-1"],
    ["small_change_lines", "1.5"],
    ["small_summary_chars", "30.0"],
    ["small_summary_chars", "true"],
    ["small_summary_chars", "null"],
  ]) {
    writeFileSync(p, good.replace(new RegExp(`"${key}": [^,\\n]+`), `"${key}": ${bad}`));
    throwsGate(() => gate.status(dev), new RegExp(`"${key}" must be a non-negative integer`));
  }
});

test("no fast path while the base branch's gate predates it, so CI agrees", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  gate.save({ summary: SHORT, verified: { "src/app.js": ["x"] } }, dev); // main's gate knows the fast path...
  commitAll(dev, "small change + report");
  onMain(
    dev,
    () =>
      writeFileSync(
        join(dev, REPO_GATE), // ...until main goes back to one that doesn't
        read(dev, REPO_GATE).replace(/^\/\/ ownership-gate-features: .*\n/m, ""),
      ),
    "older gate",
  );
  const st = gate.status(dev);
  assert.equal(st.small_change, false);
  assert.ok(
    st.notes.some((n) => n.includes("would count as a small change (2 changed lines)")),
    st.notes.join("\n"),
  );
  const [passed, problems] = gate.verify(dev);
  assert.ok(!passed && problems.some((m) => m.includes("summary is missing or too short")), problems.join("\n"));
  throwsGate(() => gate.save({ summary: SHORT, verified: { "src/app.js": ["x"] } }, dev), /at least 80 characters/);
});
