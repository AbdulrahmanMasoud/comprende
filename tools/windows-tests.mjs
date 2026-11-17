// The test suite on Windows, where some tests still fail for known reasons (#10).
// The Windows workflow runs this instead of `npm test`.
//
//   node tools/windows-tests.mjs
//
// It runs test/*.test.mjs as `npm test` does, then compares the results with the list
// in test/windows-known-failures.mjs. The run fails when:
//   - a test fails that isn't on the list, or fails with another error than it says
//   - a test on the list passes: it's fixed, so its entry comes off the list
//   - a test on the list doesn't run, or is skipped: renamed or removed, so the list is out of date
// The list applies on Windows only. Elsewhere every failure fails the run, as in `npm test`.
//
// Plain JavaScript with node: built-ins only. tsconfig.json type-checks it from the JSDoc.

import { readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { pathToFileURL } from "node:url";
import { WHOLE_FILE, WINDOWS_KNOWN_FAILURES } from "../test/windows-known-failures.mjs";

const LIST = "test/windows-known-failures.mjs";

/** @typedef {{ file: string, test: string, outcome: "pass" | "fail" | "skip", error: string }} Result */
/** @typedef {{ file: string, test: string, fails: string, issue: number, cause: string }} KnownFailure */

/**
 * What's wrong with a run, given the failures it may have: one line each. Empty means
 * the run is green.
 * @param {readonly Result[]} results one per top-level test, and one per file that crashed
 * @param {readonly KnownFailure[]} known
 * @returns {string[]}
 */
export function checkResults(results, known) {
  const key = (/** @type {{ file: string, test: string }} */ entry) => `${entry.file}\n${entry.test}`;
  const listed = new Map(known.map((entry) => [key(entry), entry]));
  const seen = new Map(results.map((result) => [key(result), result]));
  const name = (/** @type {{ file: string, test: string }} */ entry) =>
    entry.test === WHOLE_FILE ? entry.file : `${entry.file}: "${entry.test}"`;
  const problems = [];
  if (results.length === 0) problems.push("No tests ran.");
  for (const result of results) {
    if (result.outcome !== "fail") continue;
    const entry = listed.get(key(result));
    if (!entry) problems.push(`${name(result)} failed, and isn't a known Windows failure:\n${indent(result.error)}`);
    else if (!result.error.includes(entry.fails))
      problems.push(
        `${name(result)} failed, but not with the error ${LIST} expects (${JSON.stringify(entry.fails)}):\n${indent(result.error)}`,
      );
  }
  for (const entry of known) {
    const result = seen.get(key(entry));
    if (entry.test === WHOLE_FILE && !result)
      problems.push(`${entry.file} no longer crashes: take it off ${LIST} (#${entry.issue}).`);
    else if (!result) problems.push(`${name(entry)} didn't run. Renamed or removed? Update ${LIST}.`);
    else if (result.outcome === "pass") problems.push(`${name(entry)} passed: take it off ${LIST} (#${entry.issue}).`);
    else if (result.outcome === "skip") problems.push(`${name(entry)} was skipped. A known failure must run: ${LIST}.`);
  }
  return problems;
}

/** @param {string} text */
const indent = (text) =>
  text
    .trim()
    .split("\n")
    .slice(0, 12)
    .map((line) => `    ${line}`)
    .join("\n");

/** A file as the list names it: from the repo, with forward slashes. @param {string} file */
const listPath = (file) => relative(process.cwd(), resolve(file)).split(sep).join("/");

/**
 * The error a test failed with: node:test wraps it, and keeps the one thrown as `cause`.
 * @param {unknown} error
 */
function errorText(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : "";
  return cause && cause !== error.message ? `${error.message}\n${cause}` : error.message;
}

/**
 * Runs `files` as `npm test` does, with its usual output, and returns one result per
 * top-level test. A file that crashes gets one more, for WHOLE_FILE: a crash while it
 * loads fails the file, and one after its first tests ran comes only as a diagnostic.
 * @param {string[]} files
 * @returns {Promise<Result[]>}
 */
async function runTests(files) {
  /** @type {Result[]} */
  const results = [];
  /** @type {Map<string, { failed: boolean, text: string[] }>} */
  const crashes = new Map();
  /** @param {string} file */
  const crashOf = (file) => {
    const crash = crashes.get(file) ?? { failed: false, text: [] };
    crashes.set(file, crash);
    return crash;
  };
  /** @type {Map<string, string>} */
  const stderr = new Map();
  const stream = run({ files, concurrency: 4 });
  stream.on("test:pass", (test) => {
    if (test.nesting !== 0 || !test.file) return;
    const skipped = test.skip !== undefined && test.skip !== false;
    results.push({ file: listPath(test.file), test: test.name, outcome: skipped ? "skip" : "pass", error: "" });
  });
  stream.on("test:fail", (test) => {
    if (test.nesting !== 0 || !test.file) return;
    const file = listPath(test.file);
    if (listPath(test.name) === file) crashOf(file).failed = true;
    else results.push({ file, test: test.name, outcome: "fail", error: errorText(test.details.error) });
  });
  stream.on("test:stderr", (output) => {
    const file = listPath(output.file);
    stderr.set(file, (stderr.get(file) ?? "") + output.message);
  });
  stream.on("test:diagnostic", (diagnostic) => {
    if (diagnostic.file && diagnostic.message.startsWith("Error: ")) {
      const crash = crashOf(listPath(diagnostic.file));
      crash.failed = true;
      crash.text.push(diagnostic.message);
    }
  });
  for await (const chunk of stream.compose(new spec())) process.stdout.write(chunk);
  for (const [file, crash] of crashes)
    if (crash.failed)
      results.push({
        file,
        test: WHOLE_FILE,
        outcome: "fail",
        error: [...crash.text, stderr.get(file) ?? ""].join("\n"),
      });
  return results;
}

async function main() {
  const files = readdirSync("test")
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => `test/${name}`);
  const results = await runTests(files);
  const known = process.platform === "win32" ? WINDOWS_KNOWN_FAILURES : [];
  const problems = checkResults(results, known);
  if (known.length > 0) {
    console.log(`\nKnown Windows failures (${LIST}): ${known.length}`);
    for (const entry of known) console.log(`  #${entry.issue} ${entry.file}: ${entry.test}`);
  }
  if (problems.length === 0) {
    console.log(known.length > 0 ? "Each failed as listed, and nothing else failed." : "Every test passed.");
    return;
  }
  console.log(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.log(`- ${problem}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
