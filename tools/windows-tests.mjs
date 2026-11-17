// The test suite on Windows, where some tests still fail for known reasons (#10).
// The Windows workflow runs this instead of `npm test`.
//
//   node tools/windows-tests.mjs
//
// It runs test/*.test.mjs as `npm test` does, then checks the results against the list
// in test/windows-known-failures.mjs: green only while each listed test fails as listed
// and nothing else fails. What a red run means: CONTRIBUTING.md, "Windows". The list
// applies on Windows only. Elsewhere every failure fails the run, as in `npm test`.
//
// Plain JavaScript with node: built-ins only. tsconfig.json type-checks it from the JSDoc.

import { readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { pathToFileURL } from "node:url";
import { WHOLE_FILE, WINDOWS_KNOWN_FAILURES } from "../test/windows-known-failures.mjs";

const LIST_FILE = "test/windows-known-failures.mjs";
// Where a failure comes without its file. No list entry can match it, so it fails the run.
const NO_FILE = "(no file)";

/** @typedef {{ file: string, test: string, outcome: "pass" | "fail" | "skip", error: string }} Result */
/** @typedef {typeof WINDOWS_KNOWN_FAILURES[number]} KnownFailure */

/**
 * What's wrong with a run, given the failures it may have: one line each. Empty means
 * the run is green.
 * @param {readonly Result[]} results one per top-level test, and one per crash of a file
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
    else if (!result.error.includes(entry.failsWith))
      problems.push(
        `${name(result)} failed, but not with the error ${LIST_FILE} expects (${JSON.stringify(entry.failsWith)}):\n${indent(result.error)}`,
      );
  }
  for (const entry of known) {
    const result = seen.get(key(entry));
    if (entry.test === WHOLE_FILE && !result)
      problems.push(`${entry.file} no longer crashes: take it off ${LIST_FILE} (#${entry.issue}).`);
    else if (!result) problems.push(`${name(entry)} didn't run. Renamed or removed? Update ${LIST_FILE}.`);
    else if (result.outcome === "pass")
      problems.push(`${name(entry)} passed: take it off ${LIST_FILE} (#${entry.issue}).`);
    else if (result.outcome === "skip")
      problems.push(`${name(entry)} was skipped. A known failure must run: ${LIST_FILE}.`);
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
 * top-level test, plus one for WHOLE_FILE per crash of a file. A crash while a file
 * loads fails the file, and its error is in the file's stderr. One after its first
 * tests ran may come only as a diagnostic, which is then that crash's error.
 * @param {string[]} files
 * @returns {Promise<Result[]>}
 */
async function runTests(files) {
  /** @type {Result[]} */
  const results = [];
  /** @type {{ file: string, error: string }[]} */
  const failedFiles = [];
  /** @type {Map<string, string>} */
  const stderr = new Map();
  const stream = run({ files, concurrency: 4 });
  stream.on("test:pass", (test) => {
    if (test.nesting !== 0 || !test.file) return;
    const skipped = test.skip !== undefined && test.skip !== false;
    results.push({ file: listPath(test.file), test: test.name, outcome: skipped ? "skip" : "pass", error: "" });
  });
  stream.on("test:fail", (test) => {
    if (test.nesting !== 0) return;
    const error = errorText(test.details.error);
    const file = test.file ? listPath(test.file) : NO_FILE;
    if (test.file && listPath(test.name) === file) failedFiles.push({ file, error });
    else results.push({ file, test: test.name, outcome: "fail", error });
  });
  stream.on("test:stderr", (output) => {
    const file = listPath(output.file);
    stderr.set(file, (stderr.get(file) ?? "") + output.message);
  });
  stream.on("test:diagnostic", (diagnostic) => {
    // A crash after a file's tests ran. Node 22 names the file; Node 20 doesn't.
    if (diagnostic.message.startsWith("Error: ")) {
      const file = diagnostic.file ? listPath(diagnostic.file) : NO_FILE;
      results.push({ file, test: WHOLE_FILE, outcome: "fail", error: diagnostic.message });
    }
  });
  for await (const chunk of stream.compose(new spec())) process.stdout.write(chunk);
  for (const { file, error } of failedFiles)
    results.push({ file, test: WHOLE_FILE, outcome: "fail", error: `${error}\n${stderr.get(file) ?? ""}` });
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
    console.log(`\nKnown Windows failures (${LIST_FILE}): ${known.length}`);
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
