// What runs in CI: the workflow, verify on a fresh clone, and the job summary reviewers see.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import YAML, { parse as parseYaml } from "yaml";
import {
  commitAll,
  ENV,
  gate,
  git,
  payload,
  REPO_GATE,
  read,
  runGate,
  SUMMARY,
  saveAndCommit,
  setup,
  sh,
  write,
} from "./helpers.mjs";

/** JS equivalent of impl.code_print_exit (node flavour). */
function codePrintExit(message, code, toStderr = false) {
  const stream = toStderr ? "error" : "log";
  return `console.${stream}(${JSON.stringify(message)});\nprocess.exit(${code});\n`;
}

test("the workflow is valid YAML with the expected steps", (t) => {
  const s = setup(t);
  const wf = YAML.parse(read(s.dev, ".github/workflows/ownership-check.yml"));
  const steps = wf.jobs.ownership.steps;
  assert.equal(steps[0].with["fetch-depth"], 0);
  assert.ok(steps[0].with.ref.includes("pull_request.head.sha"));
  const last = steps[steps.length - 1].run;
  assert.ok(last.includes("$RUNNER_TEMP") && last.includes(" verify --repo . "));
  assert.deepEqual(wf.permissions, { contents: "read" });
});

test("the workflow's job name is the required check's name", () => {
  const wf = parseYaml(gate.const("WORKFLOW"));
  assert.equal(wf.jobs.ownership.name, gate.const("CHECK_NAME"));
});

test("the CI workflow clears NODE_OPTIONS for the gate step", () => {
  assert.match(gate.const("WORKFLOW"), /NODE_OPTIONS: ""/);
});

test("the workflow runs the base branch's gate, not the PR's", (t) => {
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
    ...ENV,
    BASE_REF: "main",
    HEAD_REF: "feature/rate-limit",
    RUNNER_TEMP: runnerTemp,
    GITHUB_ACTIONS: "true",
  };
  const r = sh(ci, "bash", ["-e", "-c", script], { check: false, env });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes("all good!") && (r.stdout + r.stderr).includes("No ownership report"));
});

test("CI verifies a fresh clone at the PR head, even after main moves", (t) => {
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

test("a shallow clone gets an actionable error", (t) => {
  const s = setup(t);
  const { dev, tmp: dir } = s;
  write(dev, "src/app.js", "export const app = 2;\n");
  git(dev, "commit", "-qam", "x");
  git(dev, "push", "-q", "--no-verify", "-u", "origin", "feature/rate-limit");
  const shallow = join(dir, "shallow");
  git(dir, "clone", "-q", "--depth", "1", "--branch", "feature/rate-limit", `file://${s.remote}`, shallow);
  const r = runGate(shallow, ["verify", "--base", "origin/main", "--branch", "feature/rate-limit"]);
  assert.ok(r.status === 1 && r.stderr.includes("fetch-depth: 0"));
});

test("the job summary shows reviewers the summary and what was verified", (t) => {
  const { dev, tmp } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  write(dev, "src/auth/login.js", "export function login(u) { return u; }\n");
  gate.save(
    {
      summary: SUMMARY + " <script>alert(1)</script> ![x](https://evil.example/p.png)",
      verified: { "src/app.js": ["limit math"], "src/auth/login.js": ["token check <b>"] },
    },
    dev,
  );
  commitAll(dev, "with report");
  const summaryFile = join(tmp, "summary.md");
  const env = { ...ENV, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summaryFile };
  const r = runGate(dev, ["verify"], { env });
  assert.equal(r.status, 0);
  const md = readFileSync(summaryFile, "utf8");
  assert.ok(md.startsWith("## ✅ Ownership check passed"));
  assert.ok(md.includes("### The developer's summary") && md.includes("### Verified understanding"));
  assert.ok(md.includes("| src/auth/login.js 🔒 | token check &lt;b&gt; |"));
  assert.ok(!md.includes("<script>") && md.includes("&lt;script&gt;") && !md.includes("![x]"));
  assert.ok(md.includes("never scores or mistakes"));
});

test("the job summary on failure", (t) => {
  const { dev, tmp } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "no report");
  const summaryFile = join(tmp, "summary.md");
  const env = { ...ENV, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summaryFile };
  assert.equal(runGate(dev, ["verify"], { env }).status, 1);
  const md = readFileSync(summaryFile, "utf8");
  assert.ok(md.startsWith("## ❌ Ownership check failed") && md.includes("No ownership report"));
});

// no links, images, HTML, code spans or table breaks from PR authors.
test("the job summary escapes the PR author's markdown", () => {
  const s = gate.mdSafe("[click](https://evil.example) ![i](x) <b>|x| `code` **bold**");
  for (const bad of ["[click](", "![i]", "<b>", "|x|", "`code`", "**bold**"]) {
    assert.ok(!s.includes(bad), bad);
  }
});

// GitHub's runner reads any output line that starts with "::" as a workflow
// command. File names, concepts and summaries come from the PR, and a file name
// can contain a newline, so none of them may start a line of their own.
const INJECTED = "::stop-commands::pwned";
const FAKE_PASS = "## ✅ Ownership check passed";
const EVIL_NAME = `evil\n${INJECTED}\n::warning title=x::injected\n${FAKE_PASS}.js`;
const CONTROL_NAME = "tab\tesc\x1bdel\x7fcr\r%0A::x.js";

test("a file name can't inject a workflow command into CI output", { skip: process.platform === "win32" }, (t) => {
  const { dev, tmp } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  saveAndCommit(dev);
  write(dev, EVIL_NAME, "x\n");
  write(dev, CONTROL_NAME, "x\n");
  commitAll(dev, "files the report doesn't cover");
  const summaryFile = join(tmp, "summary.md");
  const r = runGate(dev, ["verify"], { env: { ...ENV, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summaryFile } });
  assert.equal(r.status, 1, r.stderr);
  for (const line of `${r.stdout}${r.stderr}`.split(/\r?\n|\r/)) {
    if (line.startsWith("::")) assert.match(line, /^::(error|warning|notice) title=Ownership check::/, line);
  }
  assert.match(
    r.stdout,
    /::error title=Ownership check::Changed after the check \(not in the report\): evil\\n::stop-commands::pwned/,
  );
  assert.match(r.stderr, /Changed after the check \(not in the report\): .*evil\\n::stop-commands::pwned\\n/);
  // Every control character is escaped, and "%" too inside an annotation.
  assert.ok(r.stderr.includes(String.raw`tab\tesc\x1bdel\x7fcr\r%0A::x.js`), r.stderr);
  assert.ok(r.stdout.includes(String.raw`tab\tesc\x1bdel\x7fcr\r%250A::x.js`), r.stdout);
});

test("a broken report quoted in an error can't inject a workflow command either", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  saveAndCommit(dev);
  const rel = gate.reportRelpath("feature/rate-limit");
  // The version error quotes the report's own "version" field, which the PR controls.
  const report = read(dev, rel).replace(/```json\n([\s\S]*?)\n```/, (_, block) => {
    const data = JSON.parse(block);
    data.version = `3\n${INJECTED}`;
    return `\`\`\`json\n${JSON.stringify(data)}\n\`\`\``;
  });
  write(dev, rel, report);
  commitAll(dev, "break the report");
  const r = runGate(dev, ["verify"], { env: { ...ENV, GITHUB_ACTIONS: "true" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Report was made by gate v3\\n::stop-commands::pwned/);
  for (const line of `${r.stdout}${r.stderr}`.split(/\r?\n|\r/)) {
    if (line.startsWith("::")) assert.match(line, /^::(error|warning|notice) title=Ownership check::/, line);
  }
});

test("PR-controlled text can't add a line to the job summary", { skip: process.platform === "win32" }, (t) => {
  const { dev, tmp } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  write(dev, EVIL_NAME, "x\n");
  gate.save(
    {
      summary: `${SUMMARY}\n${INJECTED}\n${FAKE_PASS}`,
      verified: { "src/app.js": [`limit math\n${FAKE_PASS}`], [EVIL_NAME]: ["the evil file"] },
    },
    dev,
  );
  commitAll(dev, "report");
  write(dev, "src/app.js", "export const app = 3;\n");
  commitAll(dev, "changed after the check");
  const summaryFile = join(tmp, "summary.md");
  const r = runGate(dev, ["verify"], { env: { ...ENV, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summaryFile } });
  assert.equal(r.status, 1, r.stderr);
  const lines = readFileSync(summaryFile, "utf8").split("\n");
  assert.ok(lines[0].startsWith("## ❌ Ownership check failed"), lines[0]);
  assert.ok(!lines.some((l) => l.startsWith("::") || l === FAKE_PASS || l.startsWith(INJECTED)), lines.join("\n"));
});
