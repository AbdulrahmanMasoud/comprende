// The git platform adapters: the CI config install writes, what CI's environment
// says about the change, and where reviewers see the result. GitHub is the only
// platform so far; CI itself is covered in ci.test.mjs.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gate, git, setup, tmp } from "./helpers.mjs";

test("outside any CI, the platform is the repo's: GitHub", () => {
  assert.deepEqual(gate.ciPlatform({}), {
    id: "github",
    context: { baseRef: null, headBranch: null, labels: null },
    summaryFile: null,
  });
});

test("in GitHub Actions, the head branch comes from the environment; base and labels from the workflow's flags", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_HEAD_REF: "feature/x",
    GITHUB_BASE_REF: "main",
    GITHUB_STEP_SUMMARY: "/s.md",
  };
  assert.deepEqual(gate.ciPlatform(env), {
    id: "github",
    context: { baseRef: null, headBranch: "feature/x", labels: null },
    summaryFile: "/s.md",
  });
});

test("install writes the CI workflow into a repo that has none, with the check name protect requires", (t) => {
  const { dev } = setup(t);
  assert.equal(readFileSync(join(dev, ".github/workflows/ownership-check.yml"), "utf8"), gate.const("WORKFLOW"));
  assert.match(gate.const("WORKFLOW"), new RegExp(`name: ${gate.const("CHECK_NAME")}\\n`));
});

test("install keeps an existing CI workflow, even one it can't read safely", (t) => {
  const dir = tmp(t);
  const repo = join(dir, "repo");
  git(dir, "init", "-q", "-b", "main", repo);
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, "elsewhere.yml"), "name: mine\n");
  symlinkSync(join(dir, "elsewhere.yml"), join(repo, ".github/workflows/ownership-check.yml"));
  const lines = gate.install(repo);
  assert.ok(lines.includes(".github/workflows/ownership-check.yml exists (kept)"), lines.join("\n"));
  assert.equal(readFileSync(join(dir, "elsewhere.yml"), "utf8"), "name: mine\n");
});
