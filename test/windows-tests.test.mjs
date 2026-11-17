// tools/windows-tests.mjs, which runs the suite in the Windows workflow: the known
// failures (test/windows-known-failures.mjs) keep it green only while each still fails
// as listed, and any other failure turns it red.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkResults } from "../tools/windows-tests.mjs";
import { ENV, NODE, REPO, sh, tmp, write } from "./helpers.mjs";
import { WHOLE_FILE, WINDOWS_KNOWN_FAILURES } from "./windows-known-failures.mjs";

const KNOWN = {
  file: "test/a.test.mjs",
  test: "needs /bin/sh",
  failsWith: "spawnSync /bin/sh ENOENT",
  issue: 10,
  cause: "x",
};
const CRASH = { file: "test/b.test.mjs", test: WHOLE_FILE, failsWith: "reading 'trim'", issue: 10, cause: "x" };

/** @param {string} test @param {"pass" | "fail" | "skip"} outcome */
const result = (test, outcome, error = "", file = "test/a.test.mjs") => ({ file, test, outcome, error });
const crash = (error) => result(WHOLE_FILE, "fail", error, "test/b.test.mjs");

test("known Windows failures that fail as listed keep the run green", () => {
  const results = [
    result("needs /bin/sh", "fail", "spawnSync /bin/sh ENOENT"),
    result("passes", "pass"),
    crash("TypeError: Cannot read properties of undefined (reading 'trim')"),
  ];
  assert.deepEqual(checkResults(results, [KNOWN, CRASH]), []);
});

test("a failure that isn't on the list turns the run red", () => {
  const problems = checkResults(
    [result("needs /bin/sh", "fail", "spawnSync /bin/sh ENOENT"), result("new", "fail", "boom")],
    [KNOWN],
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /test\/a\.test\.mjs: "new" failed, and isn't a known Windows failure:\n {4}boom/);
});

test("a listed test that fails with another error than the list says turns the run red", () => {
  const [problem, ...rest] = checkResults([result("needs /bin/sh", "fail", "0 !== 2")], [KNOWN]);
  assert.deepEqual(rest, []);
  assert.match(problem, /"needs \/bin\/sh" failed, but not with the error .* expects \("spawnSync \/bin\/sh ENOENT"\)/);
});

test("a listed crash can't hide another one in the same file: each must fail as listed", () => {
  const results = [crash("TypeError: … (reading 'trim')"), crash("Error: A resource generated … RangeError: new")];
  const [problem, ...rest] = checkResults(results, [CRASH]);
  assert.deepEqual(rest, []);
  assert.match(
    problem,
    /^test\/b\.test\.mjs failed, but not with the error .*\n {4}Error: A resource generated … RangeError: new$/,
  );
});

test("a listed test that passes turns the run red, so a fix gets its entry off the list", () => {
  assert.deepEqual(checkResults([result("needs /bin/sh", "pass")], [KNOWN]), [
    'test/a.test.mjs: "needs /bin/sh" passed: take it off test/windows-known-failures.mjs (#10).',
  ]);
});

test("a listed test that doesn't run or is skipped turns the run red: the list is out of date", () => {
  assert.match(
    checkResults([result("other", "pass")], [KNOWN])[0],
    /"needs \/bin\/sh" didn't run\. Renamed or removed\?/,
  );
  assert.match(checkResults([result("needs /bin/sh", "skip")], [KNOWN])[0], /"needs \/bin\/sh" was skipped/);
});

test("a listed crash that no longer happens turns the run red", () => {
  assert.deepEqual(checkResults([result("passes", "pass", "", "test/b.test.mjs")], [CRASH]), [
    "test/b.test.mjs no longer crashes: take it off test/windows-known-failures.mjs (#10).",
  ]);
});

test("a run where no test ran is red", () => {
  assert.deepEqual(checkResults([], []), ["No tests ran."]);
});

test("each known Windows failure names a test file that exists, what it fails with, why, and its issue, once", () => {
  const keys = new Set();
  for (const entry of WINDOWS_KNOWN_FAILURES) {
    const label = `${entry.file}: ${entry.test}`;
    assert.match(entry.file, /^test\/[\w-]+\.test\.mjs$/, label);
    assert.ok(existsSync(join(REPO, entry.file)), label);
    assert.ok(entry.test && entry.failsWith && entry.cause, label);
    assert.ok(Number.isInteger(entry.issue) && entry.issue > 0, label);
    assert.ok(!keys.has(label), `listed twice: ${label}`);
    keys.add(label);
  }
});

// On Windows the list applies, and its tests aren't in these folders.
test("off Windows, the tool fails on a failing test and on a file that crashes, before or after its tests ran", {
  skip: process.platform === "win32" && "the list applies on Windows",
}, (t) => {
  const tool = join(REPO, "tools/windows-tests.mjs");
  // As the workflow runs it: not inside another node --test, where run() runs nothing.
  const { NODE_TEST_CONTEXT: _, ...env } = ENV;
  const red = tmp(t);
  const passesAndFails = 'test("passes", () => {});\ntest("fails", () => { throw new Error("boom"); });\n';
  write(red, "test/a.test.mjs", `import { test } from "node:test";\n${passesAndFails}`);
  write(red, "test/b.test.mjs", "undefined.trim();\n");
  // After its tests ran: Node 22 on Windows reports such a crash only as a diagnostic.
  const late = "await new Promise((done) => setTimeout(done, 20));\nundefined.trim();\n";
  write(red, "test/c.test.mjs", `import { test } from "node:test";\n${passesAndFails}${late}`);
  const failed = sh(red, NODE, [tool], { check: false, env });
  assert.equal(failed.status, 1, failed.stdout);
  const problems = failed.stdout.split("\n- ").slice(1);
  const found = (start, text) => problems.some((p) => p.startsWith(start) && p.includes(text));
  for (const file of ["a", "c"])
    assert.ok(found(`test/${file}.test.mjs: "fails" failed, and isn't a known Windows failure:\n    boom`, ""), file);
  for (const file of ["b", "c"])
    assert.ok(found(`test/${file}.test.mjs failed, and isn't a known Windows failure:`, "reading 'trim'"), file);

  const green = tmp(t);
  write(
    green,
    "test/a.test.mjs",
    'import { test } from "node:test";\ntest("passes", () => {});\ntest.skip("skipped", () => {});\n',
  );
  const passed = sh(green, NODE, [tool], { check: false, env });
  assert.equal(passed.status, 0, passed.stdout);
  assert.match(passed.stdout, /Every test passed\.\n$/);
});
