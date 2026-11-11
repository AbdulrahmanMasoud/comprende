// The git platform adapters: the CI config install writes, what CI's environment
// says about the change, and where reviewers see the result. GitHub is the only
// platform so far; CI itself is covered in ci.test.mjs.

import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitAll, ENV, gate, git, runGate, setup, tmp, write } from "./helpers.mjs";

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

test("at a detached HEAD in CI, the gate uses the branch CI names", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked");
  git(dev, "checkout", "-q", "--detach");
  const detached = runGate(dev, ["status", "--json"]);
  assert.match(detached.stderr, /Detached HEAD: pass --branch/);
  const inCi = runGate(dev, ["status", "--json"], { env: { ...ENV, GITHUB_HEAD_REF: "feature/rate-limit" } });
  assert.equal(inCi.status, 0, inCi.stderr);
  assert.equal(JSON.parse(inCi.stdout).branch, "feature/rate-limit");
});

test("outside GitHub Actions there are no annotations, but a summary file that's set still gets the summary", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked");
  const summary = join(tmp(t), "summary.md");
  writeFileSync(summary, "");
  const r = runGate(dev, ["verify"], { env: { ...ENV, GITHUB_STEP_SUMMARY: summary } });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /^::/m);
  assert.match(readFileSync(summary, "utf8"), /^## ❌ Ownership check failed/);
});

test("install replaces a dangling symlink at the workflow's path, and keeps a directory there", (t) => {
  const dir = tmp(t);
  const workflow = ".github/workflows/ownership-check.yml";
  const repoWith = (name, put) => {
    const repo = join(dir, name);
    git(dir, "init", "-q", "-b", "main", repo);
    mkdirSync(join(repo, ".github/workflows"), { recursive: true });
    put(join(repo, workflow));
    return repo;
  };
  const dangling = repoWith("dangling", (p) => symlinkSync(join(dir, "nowhere.yml"), p));
  assert.ok(gate.install(dangling).includes(`wrote ${workflow}`));
  assert.ok(lstatSync(join(dangling, workflow)).isFile());
  const folder = repoWith("folder", (p) => mkdirSync(p));
  assert.ok(gate.install(folder).includes(`${workflow} exists (kept)`));
  assert.ok(lstatSync(join(folder, workflow)).isDirectory());
});
