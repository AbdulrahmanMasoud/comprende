// The report file: where it lives, what it holds, and when it can't be trusted.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { commitAll, gate, git, INPUT, payload, runGate, setup, sh, throwsGate, write } from "./helpers.mjs";

test("report file names never collide, and the report is readable like any repo file", (t) => {
  assert.notEqual(gate.reportRelpath("feature/x"), gate.reportRelpath("feature-x"));
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  gate.save(payload(), dev);
  const mode = statSync(join(dev, gate.reportRelpath("feature/rate-limit"))).mode & 0o777;
  assert.ok(mode & 0o044, mode.toString(8)); // group/other can read, like any repo file
});

test("a tampered or broken report fails verification", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  gate.save(payload(), dev);
  git(dev, "add", "-A");
  git(dev, "commit", "-qm", "x");
  const rel = join(dev, ".learning/checks/feature%2Frate-limit.md");
  const data = gate.parseReport(readFileSync(rel, "utf8"));
  data.files["src/app.js"] = "0".repeat(40);
  writeFileSync(rel, gate.renderReport(data));
  git(dev, "commit", "-qam", "forge");
  assert.ok(!gate.verify(dev)[0]);
  writeFileSync(rel, "# just some text\n");
  git(dev, "commit", "-qam", "broken");
  throwsGate(() => gate.verify(dev), /data block/);
});

// An outdated or broken report doesn't block saving a new one.
for (const bad of ["# no data block\n", null]) {
  test(`a broken or outdated report can be replaced [${bad === null ? "None" : JSON.stringify(bad)}]`, (t) => {
    const { dev } = setup(t);
    write(dev, "src/app.js", "export const app = 2;\n");
    const rel = join(dev, gate.reportRelpath("feature/rate-limit"));
    if (bad === null) {
      // a valid report from an older gate version
      gate.save(payload(), dev);
      const text = readFileSync(rel, "utf8").replaceAll(`"version": ${gate.const("GATE_VERSION")}`, '"version": 1');
      writeFileSync(rel, text);
    } else {
      mkdirSync(dirname(rel), { recursive: true });
      writeFileSync(rel, bad);
    }
    const st = gate.status(dev);
    assert.ok(
      st.notes.some((n) => n.includes("can't be used")),
      JSON.stringify(st.notes),
    );
    if (bad !== null) {
      assert.deepEqual(st.must_verify, ["src/app.js"]); // unreadable report: not a clean slate
    }
    gate.save(payload(), dev);
    commitAll(dev, "fresh report");
    assert.ok(gate.verify(dev)[0]);
  });
}

test("save --input reads a file that starts with a UTF-8 BOM, as PowerShell 5.1 writes it", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  write(dev, INPUT, `\uFEFF${JSON.stringify(payload())}`);
  const r = runGate(dev, ["save", "--input", INPUT]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dev, gate.reportRelpath("feature/rate-limit"))));
});

test("save --input deletes report.local.json only after the report is written", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  const report = join(dev, gate.reportRelpath("feature/rate-limit"));
  write(dev, INPUT, JSON.stringify({ summary: "too short", verified: { "src/app.js": ["x"] } }));
  assert.notEqual(runGate(dev, ["save", "--input", INPUT]).status, 0); // refused: kept
  assert.ok(existsSync(join(dev, INPUT)) && !existsSync(report));
  write(dev, INPUT, JSON.stringify(payload()));
  const r = runGate(dev, ["save", "--input", INPUT]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(report) && !existsSync(join(dev, INPUT))); // saved: removed
  assert.match(r.stdout, /Removed \.learning\/report\.local\.json/);
  const other = join(".git", "my-report.json"); // any other input stays
  write(dev, other, JSON.stringify(payload()));
  assert.equal(runGate(dev, ["save", "--input", other]).status, 0);
  assert.ok(existsSync(join(dev, other)));
  commitAll(dev, "change + report");
  assert.deepEqual(gate.verify(dev), [true, [], "required"]);
  assert.equal(sh(dev, "git", ["status", "--porcelain"]).stdout, "");
});

test("a report with CRLF line endings reads the same as with LF", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  gate.save(payload(), dev);
  const lf = readFileSync(join(dev, gate.reportRelpath("feature/rate-limit")), "utf8");
  assert.deepEqual(gate.parseReport(lf.replaceAll("\n", "\r\n")), gate.parseReport(lf));
});

test("a report with CRLF line endings still counts: no new questions, and verify passes", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  gate.save(payload(), dev);
  const report = join(dev, gate.reportRelpath("feature/rate-limit"));
  // What git's core.autocrlf checks out on Windows (after a rebase, say), or an editor saves there.
  writeFileSync(report, readFileSync(report, "utf8").replaceAll("\n", "\r\n"));
  const st = gate.status(dev);
  assert.deepEqual(
    st.files.map((f) => f.state),
    ["ok"],
  );
  assert.deepEqual(st.must_verify, []);
  commitAll(dev, "change + CRLF report"); // the blob keeps CRLF: core.autocrlf is off here
  assert.deepEqual(gate.verify(dev), [true, [], "required"]);
});

// save --input resolves both paths with the native realpath (which expands 8.3
// short names) before comparing them. Only Windows runs that part: here, the comparison.
test("paths are compared ignoring letter case on Windows only", () => {
  const long = "C:\\Users\\runneradmin\\repo\\.learning\\report.local.json";
  const otherCase = "c:\\users\\RUNNERADMIN\\repo\\.learning\\report.local.json";
  assert.equal(gate.samePath(long, otherCase, "win32"), true);
  assert.equal(gate.samePath(long, otherCase, "linux"), false);
  assert.equal(
    gate.samePath("/srv/repo/.learning/report.local.json", "/srv/repo/.learning/report.local.json", "linux"),
    true,
  );
  assert.equal(gate.samePath(long, "C:\\Users\\runneradmin\\other\\.learning\\report.local.json", "win32"), false);
});
