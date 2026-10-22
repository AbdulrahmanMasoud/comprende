// Port of mcp/tests/test_gate_review2.py.
// Regression tests for the second independent review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, join } from "node:path";
import {
  ENV, REPO_GATE, callTool, commitAll, gate, git, gitTry, payload, runGate, saveAndCommit, setup,
  throwsGate, tmp, write,
} from "./helpers.mjs";

const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const readJson = (root, rel) => JSON.parse(read(root, rel));

/** Node version of impl.code_version_stub / code_write_marker. */
const codeVersionStub = (version, marker) =>
  `// ownership-gate-version: ${version}\n` +
  `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'x');\n`;

/** Push, then verify from a fresh clone with no user config — like CI. */
function ciVerify(s, branch = "feature/rate-limit", envExtra = undefined) {
  const { dev, tmp: dir } = s;
  git(dev, "push", "-q", "-f", "--no-verify", "origin", `HEAD:refs/heads/${branch}`);
  const ci = join(dir, `ci-${process.hrtime.bigint()}`);
  git(dir, "clone", "-q", s.remote, ci);
  git(ci, "checkout", "-q", "--detach", `origin/${branch}`);
  const env = { ...ENV };
  delete env.GIT_CONFIG_GLOBAL;
  Object.assign(env, { GIT_CONFIG_GLOBAL: devNull, ...(envExtra ?? {}) });
  return runGate(ci, ["verify", "--base", "origin/main", "--branch", branch], { env });
}

// 1. Moving an identical edit to another place in the file is a different change.
test("moving an edit between identical blocks is stale", (t) => {
  const { dev } = setup(t);
  const block = "  role: user\n  mfa: true\n  limits: default\n";
  const base = `bot:\n${block}admin:\n${block}`;
  git(dev, "checkout", "-q", "main");
  write(dev, "config/users.yml", base);
  commitAll(dev, "users");
  git(dev, "push", "-q", "origin", "main");
  git(dev, "checkout", "-q", "-B", "feature/rate-limit");
  // Python: str.replace(..., 1) — first occurrence only, like JS String.replace with a string.
  write(dev, "config/users.yml", base.replace("bot:\n  role: user\n  mfa: true", "bot:\n  role: user\n  mfa: false"));
  saveAndCommit(dev, { "config/users.yml": ["MFA off for the test bot"] });
  assert.ok(gate.verify(dev)[0]);
  const moved = base.replaceAll("admin:\n  role: user\n  mfa: true", "admin:\n  role: user\n  mfa: false");
  write(dev, "config/users.yml", moved);
  commitAll(dev, "move the edit to admin");
  const [passed, problems] = gate.verify(dev);
  assert.ok(!passed && problems[0].includes("config/users.yml"), JSON.stringify(problems));
});

// 2. Ignored files are still tracked; plumbing patterns are exact.
test("ignored files are tracked after report and plumbing is narrow", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "require('./x');\n");
  write(dev, "package-lock.json", '{"resolved": "https://registry.npmjs.org/x.tgz"}\n');
  saveAndCommit(dev);
  assert.ok(gate.verify(dev)[0]);
  write(dev, "package-lock.json", '{"resolved": "https://evil.example/x.tgz"}\n');
  commitAll(dev, "swap tarball");
  const [passed, problems] = gate.verify(dev);
  assert.ok(!passed && problems[0].includes("package-lock.json"), JSON.stringify(problems));

  for (const sneaky of [".learning/checks/helper.js", ".learning/checks/sub/x.md", ".learning/decisions/run.sh"]) {
    assert.ok(!gate.isPlumbing(sneaky), sneaky);
  }
  for (const real of [".learning/checks/feature%2Fx.md", ".learning/decisions/0001-x.md", ".learning/map.md",
    ".learning/me.local.md", ".github/CODEOWNERS"]) {
    assert.ok(gate.isPlumbing(real), real);
  }
});

// 3. The developer's git config, attributes and env can't make local and CI disagree.
test("user git config and env don't change fingerprints", (t) => {
  const s = setup(t);
  const { dev, tmp: dir } = s;
  const tmpPath = tmp(t);
  const lib = join(dir, "lib");
  git(dir, "init", "-q", "-b", "main", lib);
  write(lib, "l.txt", "1\n");
  commitAll(lib, "l1");
  git(dev, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
  const attrs = join(tmpPath, "attrs");
  writeFileSync(attrs, "*.py -diff\n*.txt diff=weird\n");
  for (const [k, v] of Object.entries({
    "diff.suppressBlankEmpty": "true", "diff.submodule": "log", "core.bigFileThreshold": "1",
    "core.attributesFile": attrs, "diff.weird.binary": "true", "diff.algorithm": "patience",
    "color.ui": "always", "diff.noprefix": "true", "core.quotePath": "false",
    "diff.relative": "true", "core.pager": "cat",
  })) {
    git(dev, "config", k, v);
  }
  write(dev, "src/big.py", Array.from({ length: 2000 }, (_, i) => `x${i} = ${i}\n\n`).join(""));
  write(dev, "notes.txt", "a\n\nb\n");
  const env = { ...ENV, GIT_DIFF_OPTS: "--unified=1" };
  const msg = runGate(dev, ["save"], {
    input: JSON.stringify(payload({ "src/big.py": ["generated constants"], "vendor/lib": ["why vendored"] })),
    env,
  });
  assert.equal(msg.status, 0, msg.stderr);
  commitAll(dev, "change under odd config");
  const r = ciVerify(s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// 4. Installing with --owner (which writes CODEOWNERS) needs no report.
test("install with owner needs no report", (t) => {
  const tmpPath = tmp(t);
  const remote = join(tmpPath, "remote.git");
  git(tmpPath, "init", "-q", "--bare", "-b", "main", remote);
  const repo = join(tmpPath, "r");
  git(tmpPath, "clone", "-q", remote, repo);
  git(repo, "checkout", "-q", "-b", "main");
  write(repo, "src/a.js", "a\n");
  commitAll(repo, "init");
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "checkout", "-q", "-b", "chore/add-gate");
  gate.install(repo, { owner: "@acme/leads" });
  commitAll(repo, "add gate");
  assert.ok(gate.verify(repo)[0]);
  const r = gitTry(repo, "push", "-u", "origin", "chore/add-gate");
  assert.equal(r.status, 0, r.stderr);
});

// 5. status/save use the base's rules, so a rule added on main after forking is honoured locally.
test("status uses base rules added after fork", (t) => {
  const { dev } = setup(t);
  write(dev, "src/billing/charge.js", "charge()\n");
  write(dev, "src/app.js", "export const app = 2;\n");
  git(dev, "stash", "-q", "-u");
  git(dev, "checkout", "-q", "main");
  const cfg = readJson(dev, ".learning/config.json");
  cfg.ownership_check.sensitive.push("**/billing/**");
  writeFileSync(join(dev, ".learning/config.json"), JSON.stringify(cfg));
  git(dev, "commit", "-qam", "billing is sensitive");
  git(dev, "push", "-q", "origin", "main");
  git(dev, "checkout", "-q", "feature/rate-limit");
  git(dev, "stash", "pop", "-q");
  assert.deepEqual(gate.status(dev).must_verify, ["src/billing/charge.js"]);
  throwsGate(() => gate.save(payload({ "src/app.js": ["x"] }), dev), /billing/);
});

// 6. An outdated or broken report doesn't block saving a new one.
for (const bad of ["# no data block\n", null]) {
  test(`broken or old report can be replaced [${bad === null ? "None" : JSON.stringify(bad)}]`, (t) => {
    const { dev } = setup(t);
    write(dev, "src/app.js", "export const app = 2;\n");
    const rel = join(dev, gate.reportRelpath("feature/rate-limit"));
    if (bad === null) { // a valid report from an older gate version
      gate.save(payload(), dev);
      const text = readFileSync(rel, "utf8").replaceAll(`"version": ${gate.const("GATE_VERSION")}`, '"version": 1');
      writeFileSync(rel, text);
    } else {
      mkdirSync(dirname(rel), { recursive: true });
      writeFileSync(rel, bad);
    }
    const st = gate.status(dev);
    assert.ok(st.notes.some((n) => n.includes("can't be used")), JSON.stringify(st.notes));
    if (bad !== null) {
      assert.deepEqual(st.must_verify, ["src/app.js"]); // unreadable report: not a clean slate
    }
    gate.save(payload(), dev);
    commitAll(dev, "fresh report");
    assert.ok(gate.verify(dev)[0]);
  });
}

// 7. (Revised for public release.) The MCP server never executes the repo's own
//    gate script — a cloned repo could ship anything there — and it says when versions differ.
test("server never runs repo code and flags version skew", (t) => {
  const { dev } = setup(t);
  const marker = join(tmp(t), "PWNED");
  writeFileSync(join(dev, REPO_GATE), codeVersionStub(1, marker));
  write(dev, "src/app.js", "export const app = 2;\n");
  const out = callTool("gate_status", { repo_root: dev, base: "", branch: "" });
  assert.ok(!existsSync(marker));
  assert.ok(out.includes("src/app.js [new]") && out.includes("is v1 but the running gate is"), out);
});

// 8. Forks: upstream/<base> wins over the fork's own origin/<base>.
test("upstream base preferred in forks", (t) => {
  const s = setup(t);
  const { dev, tmp: dir } = s;
  const upstream = join(dir, "upstream.git");
  git(dir, "clone", "-q", "--bare", s.remote, upstream);
  git(dev, "remote", "add", "upstream", upstream);
  git(dev, "fetch", "-q", "upstream");
  assert.equal(gate.status(dev).base, "upstream/main");
});

// 9. Performance: thousands of files in one pass.
test("many files are fast", (t) => {
  const { dev } = setup(t);
  for (let i = 0; i < 3000; i++) write(dev, `gen/f${String(i).padStart(5, "0")}.txt`, `${i}\n`);
  const start = Date.now();
  gate.save(payload({ "gen/f00000.txt": ["generator output"] }), dev);
  commitAll(dev, "lots");
  assert.ok(gate.verify(dev)[0]);
  // generous: shared CI runners are slow; this guards against O(n) git calls
  assert.ok((Date.now() - start) / 1000 < 90);
});

// 10. Hooks don't run on the throwaway index; untracked files are covered like any other.
test("no hooks on temp index and untracked counts", (t) => {
  const { dev } = setup(t);
  const hook = join(dev, ".git/hooks/post-index-change");
  const marker = join(dev, "hook-ran");
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(hook, 0o755);
  write(dev, "src/app.js", "export const app = 2;\n");
  gate.status(dev);
  assert.ok(!existsSync(marker));

  gate.save(payload(), dev);
  write(dev, "src/brand_new.js", "new code\n"); // untracked, after the report
  assert.deepEqual(gate.status(dev).must_verify, ["src/brand_new.js"]);
});

// 11. Unborn branch gets an accurate message.
test("unborn branch message", (t) => {
  const tmpPath = tmp(t);
  const repo = join(tmpPath, "r");
  git(tmpPath, "init", "-q", "-b", "main", repo);
  throwsGate(() => gate.status(repo), /no commits yet|base branch/);
});
