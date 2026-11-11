// Turning the gate on: install (and what it writes), and protect (the GitHub ruleset).

import assert from "node:assert/strict";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
  NODE,
  REPO,
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

// GitHub reads only the first CODEOWNERS it finds: .github/, then the root, then
// docs/. A file install creates in an earlier place would hide the repo's own.
test("install --owner adds to the CODEOWNERS GitHub reads, and never hides one", (t) => {
  const { dev } = setup(t);
  const theirs = "* @acme/everyone\n";
  for (const [existing, expected] of [
    [["CODEOWNERS"], "CODEOWNERS"],
    [["docs/CODEOWNERS"], "docs/CODEOWNERS"],
    [["CODEOWNERS", "docs/CODEOWNERS"], "CODEOWNERS"],
    [[".github/CODEOWNERS", "CODEOWNERS"], ".github/CODEOWNERS"],
  ]) {
    for (const p of ["CODEOWNERS", "docs/CODEOWNERS", ".github/CODEOWNERS"]) rmSync(join(dev, p), { force: true });
    for (const p of existing) write(dev, p, theirs);
    const lines = gate.install(dev, { owner: "@acme/leads" });
    const text = read(dev, expected);
    assert.ok(text.startsWith(theirs), `${expected} keeps its own lines`);
    for (const p of gate.const("GATE_FILES").filter((f) => !f.endsWith("CODEOWNERS")))
      assert.ok(text.includes(`/${p} @acme/leads`), `${expected}: ${p}`);
    assert.ok(text.includes(`/${expected} @acme/leads`), `${expected} protects itself`);
    for (const p of ["CODEOWNERS", "docs/CODEOWNERS", ".github/CODEOWNERS"].filter((f) => f !== expected))
      assert.equal(existsSync(join(dev, p)), existing.includes(p), `${p} is left as it was`);
    assert.ok(
      lines.some((l) => l.startsWith("CODEOWNERS:") && l.includes(expected)),
      lines.join("\n"),
    );
  }
  // A second run adds nothing.
  assert.ok(gate.install(dev, { owner: "@acme/leads" }).some((l) => l.startsWith("CODEOWNERS: 0 entries added")));
  // A directory named CODEOWNERS is skipped, as GitHub skips it; with nothing else, .github/ is the place.
  for (const p of ["CODEOWNERS", "docs/CODEOWNERS", ".github/CODEOWNERS"])
    rmSync(join(dev, p), { force: true, recursive: true });
  mkdirSync(join(dev, "CODEOWNERS"));
  gate.install(dev, { owner: "@acme/leads" });
  assert.ok(read(dev, ".github/CODEOWNERS").includes("/.github/CODEOWNERS @acme/leads"));
  // A symlinked CODEOWNERS isn't written through: install prints the lines instead.
  for (const p of ["CODEOWNERS", ".github/CODEOWNERS"]) rmSync(join(dev, p), { force: true, recursive: true });
  write(dev, "elsewhere", theirs);
  symlinkSync(join(dev, "elsewhere"), join(dev, "CODEOWNERS"));
  const skipped = gate.install(dev, { owner: "@acme/leads" }).find((l) => l.startsWith("SKIPPED CODEOWNERS"));
  assert.match(skipped ?? "", /\(CODEOWNERS\)\. Add these lines to it by hand/);
  assert.equal(read(dev, "elsewhere"), theirs);
  assert.equal(existsSync(join(dev, ".github/CODEOWNERS")), false);
  rmSync(join(dev, "CODEOWNERS"));
  // Without --owner, the manual step names the file GitHub reads.
  for (const p of ["CODEOWNERS", "docs/CODEOWNERS", ".github/CODEOWNERS"]) rmSync(join(dev, p), { force: true });
  write(dev, "docs/CODEOWNERS", theirs);
  assert.ok(gate.install(dev).some((l) => l.startsWith("MANUAL STEP 2: add to docs/CODEOWNERS")));
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
  assert.ok(gate.install(dev).includes(`.gitignore already has ${INPUT}`));
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

test("install keeps .learning/gate.mjs byte for byte with one .gitattributes line, added once", (t) => {
  const dir = tmp(t);
  const repo = join(dir, "r");
  git(dir, "init", "-q", "-b", "main", repo);
  write(repo, ".gitattributes", "*.png binary\n*.sh text eol=lf"); // no final newline
  const kept = "*.png binary\n*.sh text eol=lf\n.learning/gate.mjs -text\n";
  assert.ok(gate.install(repo).includes("added .learning/gate.mjs -text to .gitattributes"));
  assert.equal(read(repo, ".gitattributes"), kept);
  assert.ok(gate.install(repo).includes(".gitattributes already has .learning/gate.mjs -text"));
  assert.equal(read(repo, ".gitattributes"), kept);
  write(repo, ".gitattributes", "/.learning/gate.mjs   -text\n"); // anchored and spaced differently: the same line
  assert.ok(gate.install(repo).includes(".gitattributes already has .learning/gate.mjs -text"));
  assert.equal(read(repo, ".gitattributes"), "/.learning/gate.mjs   -text\n");
  // -text: git never converts its line endings, whatever core.autocrlf says.
  assert.equal(git(repo, "check-attr", "text", "--", REPO_GATE).stdout.trim(), `${REPO_GATE}: text: unset`);
});

test("install's .gitattributes line needs no report only once the gate CI runs knows it", (t) => {
  const { dev } = setup(t);
  const olderGate = read(dev, REPO_GATE).replace(
    /^\/\/ ownership-gate-features: .*$/m,
    "// ownership-gate-features: small-change",
  );
  // main runs an older gate (0.2.0) and has no .gitattributes line yet
  git(dev, "checkout", "-q", "main");
  writeFileSync(join(dev, REPO_GATE), olderGate);
  git(dev, "rm", "-q", "--ignore-unmatch", ".gitattributes");
  commitAll(dev, "the gate as 0.2.0 installed it");
  git(dev, "push", "-q", "--no-verify", "origin", "main");
  git(dev, "checkout", "-q", "-B", "chore/upgrade-gate");
  gate.install(dev, { upgrade: true });
  commitAll(dev, "upgrade the gate");
  // CI runs main's older gate, which counts the line as a change: so does this one.
  const [passed, problems] = gate.verify(dev);
  assert.ok(!passed && problems[0].includes("No ownership report"), problems.join("\n"));
  assert.equal(gate.status(dev).small_change, true); // one line: the fast path, so one question

  // Once main runs this gate, the same one-line edit needs nothing; any other edit does.
  git(dev, "checkout", "-q", "main");
  git(dev, "checkout", "-q", "chore/upgrade-gate", "--", REPO_GATE); // the upgraded gate, merged
  commitAll(dev, "this gate, still without the line");
  git(dev, "push", "-q", "--no-verify", "origin", "main");
  git(dev, "checkout", "-q", "-B", "chore/attributes");
  gate.install(dev);
  commitAll(dev, "add the line");
  assert.deepEqual(gate.verify(dev), [true, [], "required"]);
  write(dev, ".gitattributes", ".learning/gate.mjs -text\n*.sh text eol=lf\n");
  commitAll(dev, "and another attribute");
  const [passedToo, problemsToo] = gate.verify(dev);
  assert.ok(!passedToo && problemsToo[0].includes("No ownership report"), problemsToo.join("\n"));
});

test("install says when the gate differs only in line endings, and which side has them", (t) => {
  const { dev, tmp: dir } = setup(t);
  const lf = readFileSync(join(REPO, "dist/gate.mjs"), "utf8");
  writeFileSync(join(dev, REPO_GATE), lf.replaceAll("\n", "\r\n")); // as git's core.autocrlf checks it out
  const repoCrlf = gate.install(dev).find((line) => line.startsWith(REPO_GATE));
  assert.match(repoCrlf, /differs only in its CRLF line endings/);
  assert.ok(repoCrlf.includes("git -c core.autocrlf=false checkout -- .learning/gate.mjs"), repoCrlf);

  // A plugin copy with CRLF must not be copied in: install says to update the plugin instead.
  writeFileSync(join(dev, REPO_GATE), lf);
  write(dir, "old-plugin/gate.mjs", lf.replaceAll("\n", "\r\n"));
  const r = sh(dir, NODE, [join(dir, "old-plugin/gate.mjs"), "install", "--repo", dev, "--json"]);
  const pluginCrlf = JSON.parse(r.stdout).find((line) => line.startsWith(REPO_GATE));
  assert.match(pluginCrlf, /this gate's own CRLF line endings.*update the plugin/);
  assert.equal(read(dev, REPO_GATE), lf);
});

test("install writes .cursor/hooks.json with plain node commands, keeps other hooks, and adds them once", (t) => {
  const { dev } = setup(t);
  const fresh = JSON.parse(read(dev, ".cursor/hooks.json"));
  assert.equal(fresh.version, 1);
  assert.deepEqual(fresh.hooks.preToolUse, [
    { matcher: "Shell", command: "node .learning/gate.mjs agent-hook --agent cursor", timeout: 60, failClosed: false },
  ]);
  assert.deepEqual(fresh.hooks.sessionStart, [
    { command: "node .learning/gate.mjs session-start --from-repo --agent cursor", timeout: 30, failClosed: false },
  ]);
  // A file with the team's own hooks: they stay, and the gate's are added after them.
  const theirs = {
    version: 1,
    hooks: { preToolUse: [{ command: "./lint.sh" }], afterFileEdit: [{ command: "./fmt.sh" }] },
  };
  write(dev, ".cursor/hooks.json", JSON.stringify(theirs));
  const lines = gate.install(dev);
  assert.ok(
    lines.some((l) => l.startsWith("merged the gate's Cursor hooks into")),
    lines.join("\n"),
  );
  const merged = JSON.parse(read(dev, ".cursor/hooks.json"));
  assert.deepEqual(merged.hooks.afterFileEdit, [{ command: "./fmt.sh" }]);
  assert.equal(merged.hooks.preToolUse[0].command, "./lint.sh");
  assert.equal(merged.hooks.preToolUse.length, 2);
  // Again: nothing to add.
  const again = read(dev, ".cursor/hooks.json");
  assert.ok(gate.install(dev).some((l) => l.startsWith("Cursor hooks already present")));
  assert.equal(read(dev, ".cursor/hooks.json"), again);
});

test("install leaves a .cursor/hooks.json of a shape it doesn't know untouched", (t) => {
  const { dev } = setup(t);
  for (const body of ['{"hooks": []}', '{"hooks": {"preToolUse": {"command": "x"}}}', "not json", "[]"]) {
    write(dev, ".cursor/hooks.json", body);
    const line = gate.install(dev).find((l) => l.includes("Cursor hooks"));
    assert.match(line ?? "", /^SKIPPED Cursor hooks: .*add the hooks by hand/, body);
    assert.equal(read(dev, ".cursor/hooks.json"), body);
  }
});

test("install --upgrade adds .cursor/hooks.json, which needs no report only once the gate CI runs knows it", (t) => {
  const { dev } = setup(t);
  const olderGate = read(dev, REPO_GATE).replace(
    /^\/\/ ownership-gate-features: .*$/m,
    "// ownership-gate-features: small-change gitattributes",
  );
  // main runs a gate from before Cursor support (0.2.x), and has no .cursor/hooks.json
  git(dev, "checkout", "-q", "main");
  writeFileSync(join(dev, REPO_GATE), olderGate);
  git(dev, "rm", "-q", ".cursor/hooks.json");
  commitAll(dev, "the gate as 0.2.x installed it");
  git(dev, "push", "-q", "--no-verify", "origin", "main");
  git(dev, "checkout", "-q", "-B", "chore/upgrade-gate");
  const lines = gate.install(dev, { upgrade: true });
  assert.ok(existsSync(join(dev, ".cursor/hooks.json")), lines.join("\n"));
  commitAll(dev, "upgrade the gate");
  // CI runs main's older gate, which counts the new file as a change: so does this one.
  const [passed, problems] = gate.verify(dev);
  assert.ok(!passed && problems[0].includes("No ownership report"), problems.join("\n"));
  assert.equal(gate.status(dev).small_change, true); // a small change: one question

  // Once main runs this gate, the file is one of the gate's own, and needs nothing.
  git(dev, "checkout", "-q", "main");
  git(dev, "checkout", "-q", "chore/upgrade-gate", "--", REPO_GATE);
  commitAll(dev, "this gate, still without the file");
  git(dev, "push", "-q", "--no-verify", "origin", "main");
  git(dev, "checkout", "-q", "-B", "chore/cursor-hooks");
  gate.install(dev);
  commitAll(dev, "add the Cursor hooks");
  assert.deepEqual(gate.verify(dev), [true, [], "required"]);
});

const CODEX_GATE = 'node "$(git rev-parse --show-toplevel)/.learning/gate.mjs"';

test("install writes .codex/hooks.json with commands that find the repo, keeps other hooks, and adds them once", (t) => {
  const { dev } = setup(t);
  const fresh = read(dev, ".codex/hooks.json");
  assert.deepEqual(JSON.parse(fresh), {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: `${CODEX_GATE} agent-hook --agent codex`, timeout: 60 }],
        },
      ],
      // The session start keeps its trust across plugin updates, so it can say when the plugin's hooks were skipped.
      SessionStart: [
        { hooks: [{ type: "command", command: `${CODEX_GATE} session-start --from-repo --agent codex`, timeout: 30 }] },
      ],
    },
  });
  // Short enough that adding it is a small change.
  assert.ok(fresh.trim().split("\n").length <= 10, fresh);
  // A file with the team's own hooks: they stay, and the gate's are added after them.
  const theirs = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "./hello.sh" }] }],
      Stop: [{ hooks: [{ type: "command", command: "./notify.sh" }] }],
    },
  };
  write(dev, ".codex/hooks.json", JSON.stringify(theirs));
  const lines = gate.install(dev);
  assert.ok(
    lines.some((l) => l.startsWith("merged Codex PreToolUse and SessionStart hooks into")),
    lines.join("\n"),
  );
  const merged = JSON.parse(read(dev, ".codex/hooks.json"));
  assert.deepEqual(merged.hooks.Stop, theirs.hooks.Stop);
  assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, "./lint.sh");
  assert.equal(merged.hooks.PreToolUse.length, 2);
  assert.deepEqual(merged.hooks.SessionStart[0], theirs.hooks.SessionStart[0]);
  assert.equal(merged.hooks.SessionStart.length, 2);
  // Again: nothing to add.
  const again = read(dev, ".codex/hooks.json");
  assert.ok(gate.install(dev).some((l) => l.startsWith("Codex hooks already present")));
  assert.equal(read(dev, ".codex/hooks.json"), again);
});

// Codex trusts each hook by its own definition, so the shell hook a teammate already
// trusted must stay exactly as it was: only the new session start needs trusting.
test("install --upgrade adds the session start to a .codex/hooks.json from 0.4.0, keeps its shell hook as it was, and needs no report", (t) => {
  const { dev } = setup(t);
  const shellHook = JSON.parse(read(dev, ".codex/hooks.json")).hooks.PreToolUse;
  // main as 0.4.0 left it: only the shell hook, and a gate that knows .codex/hooks.json.
  git(dev, "checkout", "-q", "main");
  write(dev, ".codex/hooks.json", `${JSON.stringify({ hooks: { PreToolUse: shellHook } }, null, 2)}\n`);
  commitAll(dev, "the Codex hook as 0.4.0 wrote it");
  git(dev, "push", "-q", "--no-verify", "origin", "main");
  git(dev, "checkout", "-q", "-B", "chore/upgrade-gate");
  const lines = gate.install(dev, { upgrade: true });
  assert.ok(
    lines.some((l) => l.startsWith("merged a Codex SessionStart hook into")),
    lines.join("\n"),
  );
  const upgraded = JSON.parse(read(dev, ".codex/hooks.json"));
  assert.deepEqual(upgraded.hooks.PreToolUse, shellHook);
  assert.match(upgraded.hooks.SessionStart[0].hooks[0].command, /session-start --from-repo --agent codex$/);
  // CI runs main's gate, which already knows the file as one of its own: no question.
  commitAll(dev, "upgrade the gate");
  assert.deepEqual(gate.verify(dev), [true, [], "required"]);
});

test("install leaves a .codex/hooks.json of a shape it doesn't know untouched", (t) => {
  const { dev } = setup(t);
  for (const body of [
    '{"hooks": []}',
    '{"hooks": {"PreToolUse": {"matcher": "Bash"}}}',
    '{"hooks": {"SessionStart": {"hooks": []}}}',
    "not json",
    "[]",
  ]) {
    write(dev, ".codex/hooks.json", body);
    const line = gate.install(dev).find((l) => l.includes("Codex hooks"));
    assert.match(line ?? "", /^SKIPPED Codex hooks: .*add the hooks by hand/, body);
    assert.equal(read(dev, ".codex/hooks.json"), body);
  }
});

test("install --upgrade adds .codex/hooks.json, which needs no report only once the gate CI runs knows it", (t) => {
  const { dev } = setup(t);
  const olderGate = read(dev, REPO_GATE).replace(
    /^\/\/ ownership-gate-features: .*$/m,
    "// ownership-gate-features: small-change gitattributes cursor-hooks",
  );
  // main runs a gate from before Codex support (0.3.x), and has no .codex/hooks.json
  git(dev, "checkout", "-q", "main");
  writeFileSync(join(dev, REPO_GATE), olderGate);
  git(dev, "rm", "-q", ".codex/hooks.json");
  commitAll(dev, "the gate as 0.3.x installed it");
  git(dev, "push", "-q", "--no-verify", "origin", "main");
  git(dev, "checkout", "-q", "-B", "chore/upgrade-gate");
  const lines = gate.install(dev, { upgrade: true });
  assert.ok(existsSync(join(dev, ".codex/hooks.json")), lines.join("\n"));
  commitAll(dev, "upgrade the gate");
  // CI runs main's older gate, which counts the new file as a change: so does this one.
  const [passed, problems] = gate.verify(dev);
  assert.ok(!passed && problems[0].includes("No ownership report"), problems.join("\n"));
  assert.equal(gate.status(dev).small_change, true); // a small change: one question

  // Once main runs this gate, the file is one of the gate's own, and needs nothing.
  git(dev, "checkout", "-q", "main");
  git(dev, "checkout", "-q", "chore/upgrade-gate", "--", REPO_GATE);
  commitAll(dev, "this gate, still without the file");
  git(dev, "push", "-q", "--no-verify", "origin", "main");
  git(dev, "checkout", "-q", "-B", "chore/codex-hooks");
  gate.install(dev);
  commitAll(dev, "add the Codex hook");
  assert.deepEqual(gate.verify(dev), [true, [], "required"]);
});
