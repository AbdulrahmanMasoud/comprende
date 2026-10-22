// Turning the gate on: install (and what it writes), and protect (the GitHub ruleset).

import assert from "node:assert/strict";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import {
  commitAll,
  ENV,
  gate,
  git,
  gitTry,
  INPUT,
  REPO_GATE,
  read,
  setup,
  sh,
  throwsGate,
  tmp,
  write,
} from "./helpers.mjs";

const FAKE_GH = `#!${process.execPath}
const fs = require("fs");
const log = process.env.FAKE_GH_LOG;
const mode = process.env.FAKE_GH_MODE || "ok";
const args = process.argv.slice(2);
const body = args.includes("--input") ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(log, JSON.stringify({ args, body }) + "\\n");
function main() {
  if (args[0] === "repo" && args[1] === "view") {
    process.stdout.write("acme/shop-api\\n"); return 0;
  }
  if (args[0] === "api" && args[1] === "repos/acme/shop-api/rulesets") {
    process.stdout.write(JSON.stringify(mode === "exists" ? [{ id: 7, name: "Ownership gate" }] : []) + "\\n"); return 0;
  }
  if (args.includes("-X") && args.includes("POST")) {
    if (mode === "forbidden") {
      process.stderr.write("gh: Must have admin rights to Repository. (HTTP 403)\\n"); return 1;
    }
    if (mode === "free-private") {
      process.stderr.write("gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)\\n");
      return 1;
    }
    process.stdout.write(JSON.stringify({ id: 42 }) + "\\n"); return 0;
  }
  return 1;
}
process.exitCode = main();
`;

/** Fixture: a fake `gh` on PATH that logs its calls. Returns the env to pass
 *  to the gate (instead of monkeypatching os.environ) and a log reader. */
function fakeGh(dir, mode) {
  const bindir = join(dir, "fakebin");
  mkdirSync(bindir);
  const gh = join(bindir, "gh");
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);
  const log = join(dir, "gh.log");
  const env = { ...ENV, PATH: `${bindir}${delimiter}${ENV.PATH}`, FAKE_GH_LOG: log };
  if (mode) env.FAKE_GH_MODE = mode;
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l))
      : [];
  return { env, calls };
}

/** shutil.which equivalent over ENV.PATH. */
function which(cmd) {
  for (const d of (ENV.PATH ?? "").split(delimiter)) {
    if (!d) continue;
    const p = join(d, cmd);
    try {
      if (statSync(p).isFile()) {
        accessSync(p, constants.X_OK);
        return p;
      }
    } catch {
      /* keep looking */
    }
  }
  throw new Error(`${cmd} not found on PATH`);
}

test("install writes everything and is idempotent", (t) => {
  const s = setup(t);
  const dev = s.dev;
  for (const rel of [
    REPO_GATE,
    ".learning/config.json",
    ".github/workflows/ownership-check.yml",
    ".claude/settings.json",
  ]) {
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

test("install merges into existing Claude settings and keeps a foreign hook", (t) => {
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
  assert.deepEqual(
    s.hooks.PreToolUse.map((g) => g.matcher),
    ["Edit", "Bash"],
  );
  assert.ok(out.some((l) => l.startsWith("SKIPPED pre-push")));
  assert.equal(read(repo, ".git/hooks/pre-push"), "#!/bin/sh\necho mine\n");
});

test("install writes CODEOWNERS for the gate's files when an owner is given", (t) => {
  const { dev } = setup(t);
  const outLines = gate.install(dev, { owner: "@acme/leads" });
  const text = read(dev, ".github/CODEOWNERS");
  for (const p of gate.const("GATE_FILES")) assert.ok(text.includes(`/${p} @acme/leads`), p);
  assert.ok(outLines.some((l) => l.includes("Require review from Code Owners")));
  gate.install(dev, { owner: "@acme/leads" });
  assert.equal(read(dev, ".github/CODEOWNERS"), text); // idempotent
  throwsGate(() => gate.install(dev, { owner: "not a handle; rm -rf /" }));
});

test("install leaves a settings.json with hooks of an unexpected shape untouched", (t) => {
  const p = join(tmp(t), "settings.json");
  for (const body of ['{"hooks": []}', '{"hooks": {"PreToolUse": {"matcher": "Bash"}}}']) {
    writeFileSync(p, body);
    assert.match(gate.mergeClaudeSettings(p), /SKIPPED/);
    assert.equal(readFileSync(p, "utf8"), body);
  }
});

test("install adds report.local.json to .gitignore once and keeps its lines", (t) => {
  const { dev } = setup(t);
  assert.equal(read(dev, ".gitignore"), `${INPUT}\n`); // created when missing
  writeFileSync(join(dev, ".gitignore"), "node_modules/\n*.log"); // no trailing newline
  assert.ok(gate.install(dev).includes(`added ${INPUT} to .gitignore`));
  assert.equal(read(dev, ".gitignore"), `node_modules/\n*.log\n${INPUT}\n`);
  assert.ok(gate.install(dev).includes(`.gitignore already ignores ${INPUT}`));
  assert.equal(read(dev, ".gitignore"), `node_modules/\n*.log\n${INPUT}\n`);
});

test("the PR that installs the gate needs no report", (t) => {
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

// Installing with --owner (which writes CODEOWNERS) needs no report.
test("the install PR with CODEOWNERS needs no report", (t) => {
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

test("install's one .gitignore line needs no report; any other .gitignore edit does", (t) => {
  const dir = tmp(t); // main has no gate yet
  const remote = join(dir, "remote.git");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  const dev = join(dir, "dev");
  git(dir, "clone", "-q", remote, dev);
  git(dev, "checkout", "-q", "-b", "main");
  write(dev, "src/app.js", "export const app = 1;\n");
  write(dev, ".gitignore", "node_modules/\n");
  commitAll(dev, "init");
  git(dev, "push", "-q", "-u", "origin", "main");
  git(dev, "remote", "set-head", "origin", "main");
  git(dev, "checkout", "-q", "-b", "chore/ownership-gate");
  gate.install(dev);
  commitAll(dev, "add ownership gate");
  assert.equal(read(dev, ".gitignore"), `node_modules/\n${INPUT}\n`);
  assert.deepEqual(gate.verify(dev), [true, [], "required"]);
  write(dev, ".gitignore", `node_modules/\n${INPUT}\ndist/\n`);
  commitAll(dev, "ignore dist too");
  const [passed, problems] = gate.verify(dev);
  assert.ok(!passed && problems[0].includes("No ownership report"), problems.join("\n"));
});

test("protect dry run changes nothing", (t) => {
  const { dev, tmp } = setup(t);
  const gh = fakeGh(tmp);
  const out = gate.protect(dev, { approvals: 1 }, gh.env);
  assert.ok(out.some((l) => l.includes("Dry run")));
  const last = out[out.length - 1];
  assert.ok(last.includes('"context": "Ownership check"') && last.includes("~DEFAULT_BRANCH"));
  assert.ok(!gh.calls().some((c) => c.args.includes("POST")));
});

test("protect apply creates the ruleset", (t) => {
  const { dev, tmp } = setup(t);
  const gh = fakeGh(tmp);
  const out = gate.protect(dev, { apply: true, approvals: 2 }, gh.env);
  assert.equal(out[out.length - 1], "Created: https://github.com/acme/shop-api/rules/42");
  const post = gh.calls().filter((c) => c.args.includes("POST"))[0];
  const body = JSON.parse(post.body);
  assert.deepEqual(post.args.slice(0, 4), ["api", "-X", "POST", "repos/acme/shop-api/rulesets"]);
  const rules = Object.fromEntries(body.rules.map((r) => [r.type, r.parameters]));
  assert.equal(rules.pull_request.required_approving_review_count, 2);
  assert.equal(rules.pull_request.require_code_owner_review, true);
  assert.deepEqual(rules.required_status_checks.required_status_checks, [{ context: "Ownership check" }]);
});

// Parametrized: (mode, match). The helper omits --approvals when unset, so pass 1, the default.
for (const [mode, match] of [
  ["exists", "already exists"],
  ["forbidden", "admin"],
  ["free-private", "free plan"],
]) {
  test(`protect says why it couldn't create the ruleset [${mode}-${match}]`, (t) => {
    const { dev, tmp } = setup(t);
    const gh = fakeGh(tmp, mode);
    if (mode === "exists") {
      assert.ok(gate.protect(dev, { apply: true, approvals: 1 }, gh.env)[0].includes(match));
      assert.ok(!gh.calls().some((c) => c.args.includes("POST")));
    } else {
      throwsGate(() => gate.protect(dev, { apply: true, approvals: 1 }, gh.env), new RegExp(match));
    }
  });
}

test("protect without the GitHub CLI says it's needed", (t) => {
  const { dev, tmp } = setup(t);
  const onlyGit = join(tmp, "only-git");
  mkdirSync(onlyGit);
  symlinkSync(which("git"), join(onlyGit, "git"));
  // gateCli runs process.execPath directly, so node itself is still found.
  throwsGate(() => gate.protect(dev, { approvals: 1 }, { ...ENV, PATH: onlyGit }), /GitHub CLI/);
});
