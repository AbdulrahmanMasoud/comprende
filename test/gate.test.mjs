// Port of mcp/tests/test_gate.py.
// Gate tests against real git repositories: a bare "GitHub" remote, a
// developer clone, real pushes through the installed pre-push hook, and a
// fresh CI-style clone checked out at the PR head.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  ENV, REPO_GATE, SUMMARY, gate, git, payload, runGate, setup, sh, throwsGate, tmp, write,
} from "./helpers.mjs";

const read = (root, rel) => readFileSync(join(root, rel), "utf8");

/** JS equivalent of impl.code_print_exit (node flavour). */
function codePrintExit(message, code, toStderr = false) {
  const stream = toStderr ? "error" : "log";
  return `console.${stream}(${JSON.stringify(message)});\nprocess.exit(${code});\n`;
}

// ------------------------------------------------------------- install

test("install writes everything and is idempotent", (t) => {
  const s = setup(t);
  const dev = s.dev;
  for (const rel of [REPO_GATE, ".learning/config.json", ".github/workflows/ownership-check.yml",
    ".claude/settings.json"]) {
    assert.ok(existsSync(join(dev, rel)), rel);
  }
  const hook = join(dev, ".git", "hooks", "pre-push");
  assert.doesNotThrow(() => accessSync(hook, constants.X_OK));
  const cfg = JSON.parse(read(dev, ".learning/config.json")).ownership_check;
  assert.ok(cfg.base === "main" && cfg.mode === "required");
  assert.ok(s.installOutput.some((line) => line.includes("MANUAL STEP")));

  const again = gate.install(dev);
  assert.ok(again.some((l) => l.includes("up to date")));
  assert.ok(again.some((l) => l.includes("already present")));
  assert.ok(again.some((l) => l.includes("already installed")));
  const settings = JSON.parse(read(dev, ".claude/settings.json"));
  assert.equal(settings.hooks.PreToolUse.length, 1);
});

test("install merges existing claude settings and respects foreign hook", (t) => {
  const dir = tmp(t);
  const repo = join(dir, "r");
  git(dir, "init", "-q", "-b", "main", repo);
  write(repo, "a.txt", "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const existing = {
    permissions: { allow: ["Bash(npm test)"] },
    hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "lint" }] }] },
  };
  write(repo, ".claude/settings.json", JSON.stringify(existing));
  write(repo, ".git/hooks/pre-push", "#!/bin/sh\necho mine\n");
  const out = gate.install(repo);
  const s = JSON.parse(read(repo, ".claude/settings.json"));
  assert.deepEqual(s.permissions, existing.permissions);
  assert.deepEqual(s.hooks.PreToolUse.map((g) => g.matcher), ["Edit", "Bash"]);
  assert.ok(out.some((l) => l.startsWith("SKIPPED pre-push")));
  assert.equal(read(repo, ".git/hooks/pre-push"), "#!/bin/sh\necho mine\n");
});

test("workflow is valid yaml with expected steps", (t) => {
  const s = setup(t);
  const wf = YAML.parse(read(s.dev, ".github/workflows/ownership-check.yml"));
  const steps = wf.jobs.ownership.steps;
  assert.equal(steps[0].with["fetch-depth"], 0);
  assert.ok(steps[0].with.ref.includes("pull_request.head.sha"));
  const last = steps[steps.length - 1].run;
  assert.ok(last.includes("$RUNNER_TEMP") && last.includes(" verify --repo . "));
  assert.deepEqual(wf.permissions, { contents: "read" });
});

// ------------------------------------------------------------- status / save / verify

test("full flow: save, commit, verify, then stale, then recheck", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  write(dev, "src/util.js", "export const util = 1;\n"); // untracked new file
  write(dev, "package-lock.json", '{"x": 1}\n'); // ignored by default

  let st = gate.status(dev);
  assert.deepEqual(Object.fromEntries(st.files.map((f) => [f.path, f.state])), {
    "package-lock.json": "new", "src/app.js": "new", "src/util.js": "new",
  });
  assert.deepEqual(st.files.filter((f) => f.ignored).map((f) => f.path), ["package-lock.json"]);
  assert.deepEqual(st.files.filter((f) => f.untracked).map((f) => f.path), ["src/util.js"]);

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

test("sensitive file must be verified", (t) => {
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

test("deleted file and only ignored changes", (t) => {
  const { dev } = setup(t);
  write(dev, "package-lock.json", '{"only": "lock"}\n');
  const st = gate.status(dev);
  assert.deepEqual(st.files.map((f) => f.ignored), [true]);
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

test("tampered or broken report fails", (t) => {
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

function setMode(root, mode) {
  const cfgPath = join(root, ".learning/config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.ownership_check.mode = mode;
  writeFileSync(cfgPath, JSON.stringify(cfg));
}

test("a PR cannot switch its own check off", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  setMode(dev, "off");
  git(dev, "commit", "-qam", "turn it off in the PR");
  const [passed, problems, mode] = gate.verify(dev);
  assert.ok(!passed && mode === "required" && problems[0].includes("No ownership report"));
  assert.equal(runGate(dev, ["verify"]).status, 1);
});

test("modes come from the base branch", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  git(dev, "commit", "-qam", "no report");

  git(dev, "checkout", "-q", "main");
  setMode(dev, "suggested");
  git(dev, "commit", "-qam", "team switches to suggested");
  git(dev, "push", "-q", "origin", "main"); // pushing the base itself isn't gated
  git(dev, "checkout", "-q", "feature/rate-limit");
  const r = runGate(dev, ["verify"]);
  assert.ok(r.status === 0 && r.stderr.includes("No ownership report")); // warns, doesn't block

  git(dev, "checkout", "-q", "main");
  setMode(dev, "off");
  git(dev, "commit", "-qam", "team switches off");
  git(dev, "push", "-q", "origin", "main");
  git(dev, "checkout", "-q", "feature/rate-limit");
  assert.deepEqual(gate.verify(dev), [true, [], "off"]);
});

test("installing the gate needs no report", (t) => {
  const dir = tmp(t);
  const remote = join(dir, "remote.git");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  const repo = join(dir, "r");
  git(dir, "clone", "-q", remote, repo);
  git(repo, "checkout", "-q", "-b", "main");
  write(repo, "src/a.js", "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "checkout", "-q", "-b", "chore/add-gate");
  gate.install(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "add gate");
  assert.deepEqual(gate.verify(repo), [true, [], "required"]);
  assert.equal(sh(repo, "git", ["push", "-u", "origin", "chore/add-gate"], { check: false }).status, 0);
});

// ------------------------------------------------------------- hooks

test("real push blocked then allowed by pre-push hook", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  git(dev, "commit", "-qam", "unchecked change");
  const blocked = sh(dev, "git", ["push", "-u", "origin", "feature/rate-limit"], { check: false });
  assert.notEqual(blocked.status, 0);
  assert.ok(blocked.stderr.includes("Ownership gate blocked") && blocked.stderr.includes("No ownership report"));

  gate.save(payload(), dev);
  git(dev, "add", "-A");
  git(dev, "commit", "-qm", "ownership report");
  const ok = sh(dev, "git", ["push", "-u", "origin", "feature/rate-limit"], { check: false });
  assert.equal(ok.status, 0, ok.stderr);
});

test("pushing another branch checks that branch, not HEAD", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  git(dev, "commit", "-qam", "unchecked");
  git(dev, "checkout", "-q", "main");
  const r = sh(dev, "git", ["push", "origin", "feature/rate-limit"], { check: false });
  assert.ok(r.status !== 0 && r.stderr.includes("feature/rate-limit"));
});

const PUSH_CASES = [
  ["git push", true],
  ["git push -u origin feature/x", true],
  ["git -C /repo push", true],
  ["git add -A && git commit -m 'x' && git push", true],
  ["GIT_TRACE=1 git push --force-with-lease", true],
  ["/usr/bin/git push", true],
  ["gh pr create --fill", true],
  ["gh pr merge 12", true],
  ["git stash push -m wip", false],
  ["echo 'git push'", false],
  ["git status", false],
  ["gh pr view", false],
  ["npm run push", false],
];
for (const [cmd, expected] of PUSH_CASES) {
  test(`is_push_command[${cmd}-${expected}]`, () => {
    assert.equal(gate.isPushCommand(cmd), expected); // strict: `is True` / `is False`
  });
}

test("claude hook blocks only pushes without report", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  git(dev, "commit", "-qam", "unchecked");

  const hook = (command, cwd = dev) => runGate(dev, ["claude-hook"], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: String(cwd) }),
  });

  assert.equal(hook("npm test").status, 0);
  const r = hook("git push");
  assert.ok(r.status === 2 && r.stderr.includes("Blocked by the ownership gate"));
  assert.equal(runGate(dev, ["claude-hook"], { input: "not json" }).status, 0); // fail open
  assert.equal(hook("git push", "/").status, 0); // not a repo: fail open

  gate.save(payload(), dev);
  git(dev, "add", "-A");
  git(dev, "commit", "-qm", "report");
  assert.equal(hook("git push").status, 0);
});

// ------------------------------------------------------------- CI

test("CI on fresh clone at PR head even after main moves", (t) => {
  const s = setup(t);
  const { dev, tmp: dir } = s;
  write(dev, "src/app.js", "export const app = 2;\n");
  gate.save(payload(), dev);
  git(dev, "add", "-A");
  git(dev, "commit", "-qm", "feature + report");
  git(dev, "push", "-q", "-u", "origin", "feature/rate-limit");
  const headSha = git(dev, "rev-parse", "HEAD").stdout.trim();

  // Someone else lands a change on main touching the same file
  const other = join(dir, "other");
  git(dir, "clone", "-q", s.remote, other);
  write(other, "src/app.js", "export const app = 1;\nexport const other = true;\n");
  git(other, "commit", "-qam", "main moves on");
  git(other, "push", "-q", "origin", "main");

  // CI: full clone, detached at the PR head, like actions/checkout with ref + fetch-depth 0
  const ci = join(dir, "ci");
  git(dir, "clone", "-q", s.remote, ci);
  git(ci, "checkout", "-q", "--detach", headSha);
  const ciEnv = { ...ENV, GITHUB_ACTIONS: "true" };
  let r = runGate(ci, ["verify", "--base", "origin/main", "--branch", "feature/rate-limit"], { env: ciEnv });
  assert.equal(r.status, 0, r.stdout + r.stderr);

  // A PR without a report fails with a GitHub annotation
  git(dev, "checkout", "-q", "-b", "feature/no-report", "main");
  write(dev, "src/app.js", "export const app = 9;\n");
  git(dev, "commit", "-qam", "no report");
  git(dev, "push", "-q", "--no-verify", "-u", "origin", "feature/no-report");
  git(ci, "fetch", "-q", "origin");
  git(ci, "checkout", "-q", "--detach", "origin/feature/no-report");
  r = runGate(ci, ["verify", "--base", "origin/main", "--branch", "feature/no-report"], { env: ciEnv });
  assert.ok(r.status === 1 && r.stdout.includes("::error title=Ownership check::"));
});

test("workflow script runs the base branch gate, not the PR's", (t) => {
  // Execute the workflow's actual shell step. A PR that replaces the gate
  // with a stub that always passes must still be checked by the real gate.
  const s = setup(t);
  const { dev, tmp: dir } = s;
  const wf = YAML.parse(read(dev, ".github/workflows/ownership-check.yml"));
  const steps = wf.jobs.ownership.steps;
  const script = steps[steps.length - 1].run;

  write(dev, "src/app.js", "export const app = 2;\n");
  write(dev, REPO_GATE, codePrintExit("all good!", 0));
  git(dev, "commit", "-qam", "sneaky");
  git(dev, "push", "-q", "--no-verify", "-u", "origin", "feature/rate-limit");

  const ci = join(dir, "ci");
  git(dir, "clone", "-q", s.remote, ci);
  git(ci, "checkout", "-q", "--detach", "origin/feature/rate-limit");
  const runnerTemp = join(dir, "runner");
  mkdirSync(runnerTemp);
  const env = {
    ...ENV, BASE_REF: "main", HEAD_REF: "feature/rate-limit",
    RUNNER_TEMP: runnerTemp, GITHUB_ACTIONS: "true",
  };
  const r = sh(ci, "bash", ["-e", "-c", script], { check: false, env });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes("all good!") && (r.stdout + r.stderr).includes("No ownership report"));
});

test("shallow clone gives actionable error", (t) => {
  const s = setup(t);
  const { dev, tmp: dir } = s;
  write(dev, "src/app.js", "export const app = 2;\n");
  git(dev, "commit", "-qam", "x");
  git(dev, "push", "-q", "--no-verify", "-u", "origin", "feature/rate-limit");
  const shallow = join(dir, "shallow");
  git(dir, "clone", "-q", "--depth", "1", "--branch", "feature/rate-limit",
    `file://${s.remote}`, shallow);
  const r = runGate(shallow, ["verify", "--base", "origin/main", "--branch", "feature/rate-limit"]);
  assert.ok(r.status === 1 && r.stderr.includes("fetch-depth: 0"));
});
