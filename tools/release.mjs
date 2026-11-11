// Release checks for this repo, used by the Consistency job in ci.yml and by
// release.yml. It reads the files in the current directory.
//
//   node tools/release.mjs check [--tag vX.Y.Z]
//     Every version field (VERSION_FIELDS below) equals the newest released
//     CHANGELOG entry: the first "## X.Y.Z" heading, after an optional
//     "## Unreleased". With --tag, the tag must be "v" followed by that version.
//
//   node tools/release.mjs notes vX.Y.Z
//     Prints that version's CHANGELOG section, for the GitHub Release notes.
//
// Plain JavaScript with node: built-ins only, so it runs before `npm ci` and on
// Node 20, which can't import src/*.ts. tsconfig.json type-checks it from the JSDoc.

import { readFileSync } from "node:fs";

const USAGE = "usage: node tools/release.mjs check [--tag vX.Y.Z] | notes vX.Y.Z";
const VERSION = /^\d+\.\d+\.\d+$/;
const UNRELEASED = "Unreleased";

/** Every field that states the plugin's version. They must all agree. */
const VERSION_FIELDS = [
  { label: ".claude-plugin/plugin.json", file: ".claude-plugin/plugin.json", path: ["version"] },
  { label: ".cursor-plugin/plugin.json", file: ".cursor-plugin/plugin.json", path: ["version"] },
  { label: ".codex-plugin/plugin.json", file: ".codex-plugin/plugin.json", path: ["version"] },
  { label: "package.json", file: "package.json", path: ["version"] },
  { label: "package-lock.json", file: "package-lock.json", path: ["version"] },
  { label: 'package-lock.json (packages[""])', file: "package-lock.json", path: ["packages", "", "version"] },
];

/** A problem to report to the person releasing, as one line, without a stack trace. */
class ReleaseError extends Error {}

/** @param {string} path */
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new ReleaseError(`can't read ${path}`);
  }
}

/** @param {string} path @returns {unknown} */
function readJson(path) {
  const text = readText(path);
  try {
    return JSON.parse(text);
  } catch {
    throw new ReleaseError(`${path} isn't valid JSON`);
  }
}

/** The value at `path` inside parsed JSON, following only the objects' own keys.
 * @param {unknown} value @param {string[]} path @returns {unknown} */
function valueAt(value, path) {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) return undefined;
    current = /** @type {Record<string, unknown>} */ (current)[key];
  }
  return current;
}

/** The version from a tag such as "v1.2.3".
 * @param {string} tag */
function versionFromTag(tag) {
  const version = tag.slice(1);
  if (!tag.startsWith("v") || !VERSION.test(version)) throw new ReleaseError(`expected a tag like v1.2.3, got ${tag}`);
  return version;
}

/**
 * The CHANGELOG's "## " entries, in order. A heading such as
 * "## 0.1.0 (first public release)" has the version "0.1.0".
 * @param {string} markdown
 * @returns {Array<{ heading: string, version: string, body: string }>}
 */
function changelogEntries(markdown) {
  return markdown
    .split(/^## /m)
    .slice(1)
    .map((entry) => {
      const lineEnd = entry.indexOf("\n");
      const heading = (lineEnd < 0 ? entry : entry.slice(0, lineEnd)).trim();
      const body = lineEnd < 0 ? "" : entry.slice(lineEnd + 1).trim();
      return { heading, version: heading.split(/\s/, 1)[0] ?? "", body };
    });
}

/** The version of the newest released entry, the one right after an optional "Unreleased".
 * @param {ReturnType<typeof changelogEntries>} entries */
function newestRelease(entries) {
  const [first] = entries[0]?.heading === UNRELEASED ? entries.slice(1) : entries;
  if (!first) throw new ReleaseError("CHANGELOG.md has no released entry (a '## X.Y.Z' heading)");
  if (!VERSION.test(first.version))
    throw new ReleaseError(`CHANGELOG.md's newest entry should be '## X.Y.Z', not '## ${first.heading}'`);
  return first.version;
}

/** How a version field differs from `version`, or null when it matches.
 * @param {(typeof VERSION_FIELDS)[number]} field @param {string} version */
function mismatch(field, version) {
  const stated = valueAt(readJson(field.file), field.path);
  if (stated === version) return null;
  return typeof stated === "string" ? `${field.label} says "${stated}"` : `${field.label} has no "version"`;
}

/** @param {string | undefined} tag */
function check(tag) {
  const version = newestRelease(changelogEntries(readText("CHANGELOG.md")));
  const mismatches = VERSION_FIELDS.map((field) => mismatch(field, version)).filter((m) => m !== null);
  if (tag !== undefined && versionFromTag(tag) !== version) mismatches.push(`the tag is ${tag}`);
  if (mismatches.length > 0)
    throw new ReleaseError(`the newest CHANGELOG.md entry is ${version}, but ${mismatches.join(", ")}`);
  const files = [...new Set(VERSION_FIELDS.map((field) => field.file)), "CHANGELOG.md"].join(", ");
  const tagged = tag === undefined ? "" : `, and so does the tag ${tag}`;
  console.log(`${version}: ${files} agree${tagged}.`);
}

/** @param {string} tag */
function notes(tag) {
  const version = versionFromTag(tag);
  const entry = changelogEntries(readText("CHANGELOG.md")).find((e) => e.version === version);
  if (!entry) throw new ReleaseError(`CHANGELOG.md has no '## ${version}' entry`);
  if (!entry.body) throw new ReleaseError(`CHANGELOG.md's '## ${version}' entry is empty`);
  console.log(entry.body);
}

/** @param {string[]} args */
function main(args) {
  const [command, ...rest] = args;
  if (command === "check" && rest.length === 0) return check(undefined);
  if (command === "check" && rest.length === 2 && rest[0] === "--tag" && rest[1]) return check(rest[1]);
  if (command === "notes" && rest.length === 1 && rest[0]) return notes(rest[0]);
  throw new ReleaseError(USAGE);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof ReleaseError)) throw error;
  console.error(`release: ${error.message}`);
  process.exitCode = 1;
}
