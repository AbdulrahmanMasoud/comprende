// Shared test helpers. Tests drive the built artifacts (dist/gate.mjs,
// dist/server.mjs) only through their command lines, against real git repos:
// a bare "GitHub" remote, a developer clone, CI-style clones.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const NODE = process.execPath;
export const GATE = join(REPO, "dist", "gate.mjs");
export const SERVER = join(REPO, "dist", "server.mjs");
export const REPO_GATE = ".learning/gate.mjs";

export const SUMMARY =
  "Added a per-IP limit on the public routes so scrapers can't hammer the database; " +
  "if Redis is down we let requests through, which is the main thing that could go wrong.";

const base = { ...process.env };
for (const k of ["GITHUB_HEAD_REF", "GITHUB_ACTIONS", "GITHUB_STEP_SUMMARY", "COMPRENDE_HOME", "COMPRENDE_QUIET", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete base[k];
export const ENV = Object.freeze({
  ...base,
  GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.com",
  GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.com",
});

export class GateError extends Error {}

/** Run a command. Throws (with output) on failure unless check=false. */
export function sh(cwd, cmd, args = [], { check = true, input, env, timeout } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, env: env ?? ENV, encoding: "utf8", maxBuffer: 1 << 28, timeout });
  if (r.error) throw r.error;
  const out = { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (check && out.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${out.stdout}\n${out.stderr}`);
  return out;
}
export const git = (cwd, ...args) => sh(cwd, "git", args);
export const gitTry = (cwd, ...args) => sh(cwd, "git", args, { check: false });

export function write(root, rel, text) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

/** A fresh temp dir, removed when the test finishes. */
export function tmp(t) {
  const d = mkdtempSync(join(tmpdir(), "eayb-test-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

export function commitAll(root, msg) {
  git(root, "add", "-A");
  git(root, "commit", "-qm", msg);
}

const strip = (s) => s.trim().replace(/^ownership gate: /, "");

// ---------------------------------------------------------------- the gate (plugin copy)

export function gateCli(args, { input, env, cwd } = {}) {
  return sh(cwd ?? REPO, NODE, [GATE, ...args], { check: false, input, env });
}
/** The repo's own installed copy. */
export function runGate(cwd, args, { input, env } = {}) {
  return sh(cwd, NODE, [join(cwd, REPO_GATE), ...args], { check: false, input, env });
}

function gjson(args, input, env) {
  const r = gateCli(args, { input, env });
  if (r.status !== 0) throw new GateError(strip(r.stderr || r.stdout));
  return JSON.parse(r.stdout);
}
const opts = (o) => Object.entries(o).flatMap(([k, v]) =>
  v === undefined || v === null || v === false ? [] : v === true ? [`--${k}`] : [`--${k}`, String(v)]);
const testFn = (fn, ...a) => gjson(["__test", fn, JSON.stringify(a)]);

export const gate = {
  status: (repo, { base, branch } = {}, env) => gjson(["status", "--json", ...opts({ repo, base, branch })], undefined, env),
  save(payload, repo, { base, branch } = {}, env) {
    const r = gateCli(["save", ...opts({ repo, base, branch })], { input: JSON.stringify(payload), env });
    if (r.status !== 0) throw new GateError(strip(r.stderr || r.stdout));
    return r.stdout.trim();
  },
  verify(repo, { base, branch, rev = "HEAD", labels } = {}, env) {
    const r = gjson(["verify", "--json", ...opts({ repo, base, branch, rev }),
      ...(labels ? ["--labels-json", JSON.stringify(labels)] : [])], undefined, env);
    return [r.passed, r.messages, r.mode];
  },
  install: (repo, { upgrade, owner } = {}) => gjson(["install", "--json", ...opts({ repo, upgrade, owner })]),
  installHooks: (repo) => gjson(["install-hooks", "--json", ...opts({ repo })]),
  protect: (repo, { apply, approvals, codeOwners = true } = {}, env) =>
    gjson(["protect", "--json", ...opts({ repo, apply, approvals, "no-code-owners": !codeOwners })], undefined, env),
  reportRelpath: (branch) => testFn("report_relpath", branch),
  readReport: (root, branch, rev = null) => testFn("read_report", root, branch, rev),
  isPushCommand: (cmd) => testFn("is_push_command", cmd),
  isPlumbing: (path, mode = "100644") => testFn("is_plumbing", path, mode),
  isSensitive: (path, mode, cfg) => testFn("is_sensitive", path, mode, cfg),
  collectChanges: (root, baseRef, rev = null) => testFn("collect_changes", root, baseRef, rev),
  mergeClaudeSettings: (path) => testFn("merge_claude_settings", path),
  mdSafe: (text) => testFn("md_safe", text),
  renderReport: (data) => testFn("render_report", data),
  parseReport: (text) => testFn("parse_report", text),
  const: (name) => testFn(name),
};

// ---------------------------------------------------------------- the MCP server

export function callTool(name, args = {}, env) {
  const r = sh(REPO, NODE, [SERVER, "call", name, JSON.stringify(args)], { check: false, env: env ?? ENV });
  if (r.status !== 0) throw new GateError(r.stderr.trim());
  return r.stdout.replace(/\n$/, "");
}

// ---------------------------------------------------------------- fixtures

export const payload = (verified) => ({ summary: SUMMARY, verified: verified ?? { "src/app.js": ["limit math"] } });

export function saveAndCommit(root, verified, msg = "report") {
  gate.save(payload(verified), root);
  commitAll(root, msg);
}

/** A bare remote with main, the gate installed and pushed, and a dev clone on
 *  feature/rate-limit. */
export function setup(t) {
  const dir = tmp(t);
  const remote = join(dir, "remote.git");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  const dev = join(dir, "dev");
  git(dir, "clone", "-q", remote, dev);
  git(dev, "checkout", "-q", "-b", "main");
  write(dev, "src/app.js", "export const app = 1;\n");
  write(dev, "src/auth/login.js", "export function login() {}\n");
  write(dev, "src/old.js", "old\n");
  write(dev, "package-lock.json", "{}\n");
  commitAll(dev, "init");
  git(dev, "push", "-q", "-u", "origin", "main");
  git(dev, "remote", "set-head", "origin", "main");
  const installOutput = gate.install(dev);
  commitAll(dev, "add ownership gate");
  git(dev, "push", "-q", "origin", "main");
  git(dev, "checkout", "-q", "-b", "feature/rate-limit");
  return { dev, remote, tmp: dir, installOutput };
}

/** Run fn and assert it throws a GateError whose message matches re. */
export function throwsGate(fn, re) {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof GateError)) throw e;
    if (re && !re.test(e.message)) throw new Error(`error ${JSON.stringify(e.message)} doesn't match ${re}`);
    return e;
  }
  throw new Error(`expected a GateError${re ? ` matching ${re}` : ""}`);
}
