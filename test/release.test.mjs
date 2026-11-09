// tools/release.mjs: the version files and the newest CHANGELOG entry agree,
// a release tag must match them, and a release's notes are its CHANGELOG section.

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NODE, REPO, sh, tmp, write } from "./helpers.mjs";

const TOOL = join(REPO, "tools/release.mjs");

const release = (cwd, ...args) => sh(cwd, NODE, [TOOL, ...args], { check: false });

const CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "- Not released yet.",
  "",
  "## 1.2.0",
  "",
  "- **New:** a thing.",
  "  - with a detail",
  "",
  "## 1.1.0 (first public release)",
  "",
  "- The first thing.",
  "",
].join("\n");

/** A project whose version files all say `version`, unless one is given its own. */
function project(
  t,
  { version = "1.2.0", plugin = version, pkg = version, lock = version, changelog = CHANGELOG } = {},
) {
  const dir = tmp(t);
  write(dir, ".claude-plugin/plugin.json", JSON.stringify({ name: "x", version: plugin }));
  write(dir, "package.json", JSON.stringify({ name: "x", version: pkg }));
  write(dir, "package-lock.json", JSON.stringify({ name: "x", version: lock, packages: { "": { version: lock } } }));
  write(dir, "CHANGELOG.md", changelog);
  return dir;
}

test("check skips the Unreleased section and compares with the newest release", (t) => {
  const r = release(project(t), "check");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "1.2.0: .claude-plugin/plugin.json, package.json, package-lock.json, CHANGELOG.md agree.\n");
});

test("check passes without an Unreleased section too", (t) => {
  const r = release(project(t, { changelog: "# Changelog\n\n## 1.2.0\n\n- x\n" }), "check");
  assert.equal(r.status, 0, r.stderr);
});

test("check names every field whose version differs, and only those", (t) => {
  const r = release(project(t, { pkg: "1.1.0", lock: "1.3.0" }), "check");
  assert.equal(r.status, 1);
  assert.equal(
    r.stderr,
    'release: the newest CHANGELOG.md entry is 1.2.0, but package.json says "1.1.0", ' +
      'package-lock.json says "1.3.0", package-lock.json (packages[""]) says "1.3.0"\n',
  );
});

test("a version bump without its CHANGELOG entry fails", (t) => {
  const r = release(project(t, { version: "1.3.0" }), "check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the newest CHANGELOG\.md entry is 1\.2\.0, but \.claude-plugin\/plugin\.json says "1\.3\.0"/);
});

test("a version file with no version says so", (t) => {
  const dir = project(t);
  write(dir, ".claude-plugin/plugin.json", JSON.stringify({ name: "x" }));
  const r = release(dir, "check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.claude-plugin\/plugin\.json has no "version"$/m);
});

test("a version file that's missing or isn't JSON is reported by name, without a stack trace", (t) => {
  const dir = project(t);
  write(dir, "package.json", "{ not json");
  assert.equal(release(dir, "check").stderr, "release: package.json isn't valid JSON\n");
  rmSync(join(dir, "package-lock.json"));
  write(dir, "package.json", JSON.stringify({ version: "1.2.0" }));
  assert.equal(release(dir, "check").stderr, "release: can't read package-lock.json\n");
});

test("the newest entry after Unreleased must be a plain X.Y.Z heading", (t) => {
  for (const heading of ["Upgrading", "1.3.0-rc.1"]) {
    const changelog = `# Changelog\n\n## Unreleased\n\n## ${heading}\n\n## 1.2.0\n\n- x\n`;
    const r = release(project(t, { changelog }), "check");
    assert.equal(r.status, 1, heading);
    assert.ok(r.stderr.endsWith(`should be '## X.Y.Z', not '## ${heading}'\n`), r.stderr);
  }
});

test("a CHANGELOG with only Unreleased has no release to compare with", (t) => {
  const r = release(project(t, { changelog: "# Changelog\n\n## Unreleased\n\n- x\n" }), "check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has no released entry/);
});

test("check --tag passes only for 'v' followed by the version", (t) => {
  const dir = project(t);
  const ok = release(dir, "check", "--tag", "v1.2.0");
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(ok.stdout.endsWith(", and so does the tag v1.2.0.\n"), ok.stdout);
  const other = release(dir, "check", "--tag", "v1.1.0");
  assert.equal(other.status, 1);
  assert.ok(other.stderr.endsWith("but the tag is v1.1.0\n"), other.stderr);
  for (const tag of ["1.2.0", "v1.2.0-rc.1", "vUnreleased"]) {
    const r = release(dir, "check", "--tag", tag);
    assert.equal(r.stderr, `release: expected a tag like v1.2.3, got ${tag}\n`);
  }
});

test("notes prints that version's section without its heading, whatever follows the version", (t) => {
  const dir = project(t);
  assert.equal(release(dir, "notes", "v1.2.0").stdout, "- **New:** a thing.\n  - with a detail\n");
  assert.equal(release(dir, "notes", "v1.1.0").stdout, "- The first thing.\n");
});

test("notes takes only a release tag, never Unreleased", (t) => {
  const dir = project(t);
  for (const tag of ["1.2.0", "vUnreleased"]) {
    const r = release(dir, "notes", tag);
    assert.equal(r.status, 1, tag);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `release: expected a tag like v1.2.3, got ${tag}\n`);
  }
});

test("notes fails for a version the CHANGELOG doesn't have, or one with an empty entry", (t) => {
  const missing = release(project(t), "notes", "v9.9.9");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no '## 9\.9\.9' entry/);
  const empty = release(project(t, { changelog: "## 1.2.0\n\n## 1.1.0\n\n- x\n" }), "notes", "v1.2.0");
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /'## 1\.2\.0' entry is empty/);
});

test("wrong arguments print the usage and fail", (t) => {
  const dir = project(t);
  for (const args of [[], ["publish"], ["check", "--tag"], ["check", "extra"], ["notes"], ["notes", "v1.2.0", "x"]]) {
    const r = release(dir, ...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /^release: usage: /, args.join(" "));
  }
});
