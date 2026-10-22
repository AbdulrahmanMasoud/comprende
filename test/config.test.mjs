// Config: strict validation, Comprende's glob rules, and rules taken from the base branch.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  commitAll,
  ENV,
  gate,
  git,
  gitTry,
  out,
  payload,
  read,
  runGate,
  setBaseConfig,
  setup,
  throwsGate,
  tmp,
  write,
} from "./helpers.mjs";

function setMode(root, mode) {
  const cfgPath = join(root, ".learning/config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.ownership_check.mode = mode;
  writeFileSync(cfgPath, JSON.stringify(cfg));
}

const readJson = (root, rel) => JSON.parse(read(root, rel));

test("a PR cannot switch its own check off", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  setMode(dev, "off");
  git(dev, "commit", "-qam", "turn it off in the PR");
  const [passed, problems, mode] = gate.verify(dev);
  assert.ok(!passed && mode === "required" && problems[0].includes("No ownership report"));
  assert.equal(runGate(dev, ["verify"]).status, 1);
});

test("the mode comes from the base branch, not the PR", (t) => {
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

// Retargeting: a base without the gate must not let the PR's own config decide.
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
  assert.ok(
    !passed && mode === "required" && problems[0].includes("No ownership report"),
    JSON.stringify({ passed, problems, mode }),
  );
  const wf = read(dev, ".github/workflows/ownership-check.yml");
  assert.ok(wf.includes("edited"));
});

test("the skip label comes from the base branch's config", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked");
  assert.equal(gate.verify(dev, { labels: ["skip-ownership-check"] })[2], "skipped");
  assert.ok(!gate.verify(dev, { labels: ["some-other-label"] })[0]);
  const r = runGate(dev, ["verify", "--labels-json", '["skip-ownership-check"]'], {
    env: { ...ENV, GITHUB_ACTIONS: "true" },
  });
  assert.ok(r.status === 0 && r.stdout.includes("::warning"), r.stdout + r.stderr);
});

// Config details the docs promise.
test("without a config, the check is only suggested locally", (t) => {
  const tmpPath = tmp(t);
  const repo = join(tmpPath, "r");
  git(tmpPath, "init", "-q", "-b", "main", repo);
  write(repo, "a.txt", "a\n");
  commitAll(repo, "init");
  const st = gate.status(repo);
  assert.ok(st.mode === "suggested" && st.configured === false, JSON.stringify(st));
});

// status/save use the base's rules, so a rule added on main after forking is honoured locally.
test("status uses rules the base branch added after the fork point", (t) => {
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

// Forks: upstream/<base> wins over the fork's own origin/<base>.
test("in a fork, upstream/<branch> is preferred as the base", (t) => {
  const s = setup(t);
  const { dev, tmp: dir } = s;
  const upstream = join(dir, "upstream.git");
  git(dir, "clone", "-q", "--bare", s.remote, upstream);
  git(dev, "remote", "add", "upstream", upstream);
  git(dev, "fetch", "-q", "upstream");
  assert.equal(gate.status(dev).base, "upstream/main");
});

// Config types are validated; a string list must not disable the gate.
for (const bad of [
  { ignore: "**/*.lock" },
  { sensitive: "src/auth/**" },
  { min_summary_chars: "80" },
  { min_summary_chars: true },
  { mode: "strict" },
  { base: 5 },
]) {
  test(`bad config types are rejected [${JSON.stringify(bad)}]`, (t) => {
    const { dev } = setup(t);
    const cfg = readJson(dev, ".learning/config.json");
    Object.assign(cfg.ownership_check, bad);
    writeFileSync(join(dev, ".learning/config.json"), JSON.stringify(cfg));
    throwsGate(() => gate.status(dev));
  });
}

test("a config that is a JSON list is rejected", (t) => {
  const { dev } = setup(t);
  writeFileSync(join(dev, ".learning/config.json"), "[1, 2]");
  throwsGate(() => gate.status(dev), /expected an object/);
});

// Config values and arguments are strict.
test("min_summary_chars must be an integer literal", (t) => {
  const { dev } = setup(t);
  for (const lit of ["80.0", "1e2"]) {
    const p = join(dev, ".learning/config.json");
    writeFileSync(p, readFileSync(p, "utf8").replace(/"min_summary_chars": [^,\n]+/, `"min_summary_chars": ${lit}`));
    throwsGate(() => gate.status(dev), /min_summary_chars/);
  }
});

test("only the gate's own min_summary_chars is checked for a float literal", (t) => {
  const { dev } = setup(t);
  const p = join(dev, ".learning/config.json");
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  writeFileSync(p, JSON.stringify({ ...cfg, notes: { min_summary_chars: 1.5 } }, null, 2));
  gate.status(dev);
  // A duplicate key: the last one wins, as JSON.parse reads it.
  writeFileSync(
    p,
    readFileSync(p, "utf8").replace('"min_summary_chars": 80', '"min_summary_chars": 1.5, "min_summary_chars": 80'),
  );
  gate.status(dev);
});

// Sensitive beats ignored.
test("a lockfile that is also sensitive needs questions and a report", (t) => {
  const { dev } = setup(t);
  write(dev, "web/payments/package-lock.json", '{"x": 1}\n');
  assert.deepEqual(gate.status(dev).must_verify, ["web/payments/package-lock.json"]);
  commitAll(dev, "payments lockfile only");
  const [passed, problems] = gate.verify(dev);
  assert.ok(!passed && problems[0].includes("No ownership report"));
});

// Globs follow Comprende's glob rules and never crash.
test("a reversed range in a config glob doesn't crash, and doesn't open the gate", (t) => {
  const { dev } = setup(t);
  setBaseConfig(dev, (c) => c.sensitive.push("[z-a]"));
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked");
  const [passed] = gate.verify(dev);
  assert.equal(passed, false);
  const r = gitTry(dev, "push", "-u", "origin", "feature/rate-limit");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Ownership gate blocked/);
});

test("glob edge cases follow Comprende's glob rules", () => {
  const cases = [
    ["a", "[]a]", true],
    ["]", "[]a]", true],
    ["b", "[]a]", false],
    ["b", "[!]]", true],
    ["]", "[!]]", false],
    ["a😀b", "a?b", true],
    ["a😀😀b", "a?b", false],
    ["x-y", "x[-]y", true],
    ["d", "[a-c-e]", false],
    ["e", "[a-c-e]", true],
    ["web/package-lock.json", "**/package-lock.json", true],
    ["package-lock.json", "**/package-lock.json", true],
    ["a.b+c(d)", "a.b+c(d)", true],
    ["axb+c(d)", "a.b+c(d)", false],
    ["anything", "[z-a]*", false],
    ["q", "[!z-a]", true],
  ];
  for (const [path, pat, want] of cases) {
    // None of these patterns can match path + "/_", which is_sensitive also tries.
    assert.equal(gate.isSensitive(path, "100644", { sensitive: [pat] }), want, `${pat} vs ${path}`);
  }
});

test("glob ranges compare code points, not UTF-16 code units", () => {
  assert.equal(gate.isSensitive("😀", "100644", { sensitive: ["[-😀]"] }), true);
  // Reversed in code points, so the range is empty, not a regex error.
  assert.equal(gate.isSensitive("😀", "100644", { sensitive: ["[😀-￿]"] }), false);
});
