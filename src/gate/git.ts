// Running git safely: a fixed environment, no commands from the repo's own config,
// and a temporary index for reading the working tree as `git add -A` would commit it.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { devNull, homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Config } from "./config.js";
import { exists, isFile } from "./files.js";
import { GateError, sorted, splitLines } from "./shared.js";

/** Environment for every git call. core.fsmonitor can name a command in the
 *  repo's own .git/config; it's forced off for all calls (GIT_CONFIG_* outranks
 *  every config file). */
export function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
  delete env.GIT_DIFF_OPTS;
  let n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  if (!Number.isFinite(n) || n < 0) n = 0;
  env.GIT_CONFIG_COUNT = String(n + 1);
  env[`GIT_CONFIG_KEY_${n}`] = "core.fsmonitor";
  env[`GIT_CONFIG_VALUE_${n}`] = "false";
  return { ...env, ...(extra ?? {}) };
}

export interface RunResult {
  status: number;
  stdout: Buffer;
  stderr: Buffer;
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer; timeout?: number } = {},
): RunResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    maxBuffer: 1 << 30,
    timeout: opts.timeout,
    windowsHide: true,
  });
  if (r.error) {
    const err = r.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") throw Object.assign(new Error(`${cmd}: not found`), { code: "ENOENT" });
    throw err;
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0) };
}

export function gitBytes(
  root: string,
  args: string[],
  opts: { env?: Record<string, string>; check?: boolean; input?: Buffer | string } = {},
): Buffer {
  let r: RunResult;
  try {
    r = run("git", args, { cwd: root, env: gitEnv(opts.env), input: opts.input });
  } catch (e) {
    throw new GateError(`Could not run git: ${(e as Error).message}`);
  }
  if ((opts.check ?? true) && r.status !== 0) {
    throw new GateError(`git ${args.slice(0, 3).join(" ")} failed: ${r.stderr.toString("utf8").trim()}`);
  }
  return r.stdout;
}

export const git = (root: string, args: string[], opts: { env?: Record<string, string>; check?: boolean } = {}) =>
  gitBytes(root, args, opts).toString("utf8");

const gitOk = (root: string, args: string[]) => {
  try {
    return run("git", args, { cwd: root, env: gitEnv() }).status === 0;
  } catch {
    return false;
  }
};

export function repoRoot(path?: string | null): string {
  let start = resolve((path || process.cwd()).replace(/^~(?=$|[/\\])/, homedir()));
  if (!exists(start)) throw new GateError(`Path does not exist: ${start}`);
  if (isFile(start)) start = dirname(start);
  let out: RunResult;
  try {
    out = run("git", ["rev-parse", "--show-toplevel"], { cwd: start, env: gitEnv() });
  } catch (e) {
    throw new GateError(`Could not run git: ${(e as Error).message}`);
  }
  const top = out.stdout.toString("utf8").trim();
  if (out.status !== 0 || !top) throw new GateError(`Not inside a git working tree: ${start}`);
  return resolve(top);
}

export const refExists = (root: string, ref: string) =>
  gitOk(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);

export const hasFile = (root: string, rev: string, rel: string) => gitOk(root, ["cat-file", "-e", `${rev}:${rel}`]);

export function readBlob(root: string, sha: string): Buffer | null {
  try {
    const r = run("git", ["cat-file", "blob", sha], { cwd: root, env: gitEnv() });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

/** `git show rev:rel` with the same size bound (checked before reading). */
export function showSmall(root: string, rev: string, rel: string, limit: number): string {
  const size = git(root, ["cat-file", "-s", `${rev}:${rel}`], { check: false }).trim();
  if (!/^\d+$/.test(size)) throw new GateError(`${rel} at ${rev} isn't readable.`);
  if (Number(size) > limit)
    throw new GateError(`${rel} at ${rev} is larger than ${Math.floor(limit / 1024)} KB — refusing to read it.`);
  return git(root, ["show", `${rev}:${rel}`]);
}

export function resolveBase(root: string, cfg: Pick<Config, "base">, base?: string | null): string {
  if (base) {
    if (!refExists(root, base))
      throw new GateError(`Base ref '${base}' not found. In CI, check out with fetch-depth: 0.`);
    return base;
  }
  const names = cfg.base ? [cfg.base] : [];
  const head = git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { check: false }).trim();
  if (head) names.push(head.replace(/^refs\/remotes\/origin\//, ""));
  names.push("main", "master");
  const candidates: string[] = [];
  for (const b of names) {
    if (b.includes("/") && ["origin", "upstream"].includes(b.split("/", 1)[0])) candidates.push(b);
    // In a fork, "upstream" is the real project; prefer it over the fork's own copy.
    else candidates.push(`upstream/${b}`, `origin/${b}`, b);
  }
  for (const ref of candidates) if (refExists(root, ref)) return ref;
  throw new GateError('Could not find the base branch. Set "base" in .learning/config.json or pass --base.');
}

export function currentBranch(root: string, branch?: string | null): string {
  if (branch) return branch;
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  const name = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { check: false }).trim();
  if (!name) throw new GateError("Detached HEAD: pass --branch <name>.");
  return name;
}

// Applied to every git call that touches the working tree: hooks are never
// wanted on our throwaway index.
export const WORKTREE_SAFE = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`];

/** `git add` runs filter commands from git config. Filters the user set up
 *  globally (git-lfs, etc.) are theirs; filters defined in *this repo's*
 *  .git/config could come from someone else (a repo shared as an archive).
 *  Refuse those unless the user says they trust them. */
function ensureRepoConfigIsInert(root: string): void {
  if (process.env.OWNERSHIP_GATE_TRUST_REPO_CONFIG === "1") return;
  const out = git(root, ["config", "--show-scope", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"], {
    check: false,
  });
  const local = new Set<string>();
  for (const line of splitLines(out)) {
    const parts = line.trim().split(/\s+/);
    if ((parts[0] === "local" || parts[0] === "worktree") && parts.length > 1) local.add(parts[1]);
  }
  if (local.size) {
    throw new GateError(
      `This repo's own .git/config defines filter commands (${sorted(local).join(", ")}) that git would run while the gate reads your changes. ` +
        "If you set these up yourself (e.g. git-crypt, or git-lfs installed with --local), rerun with OWNERSHIP_GATE_TRUST_REPO_CONFIG=1.",
    );
  }
}

/** A throwaway copy of the index with everything `git add -A` would stage.
 *  Its blob ids are exactly what a commit would contain — clean filters,
 *  line-ending rules, file↔directory swaps and submodules included — and the
 *  user's real index is never touched. */
export function withWorktreeIndex<T>(root: string, fn: (env: Record<string, string>) => T): T {
  let real = git(root, ["rev-parse", "--git-path", "index"]).trim();
  if (!isAbsolute(real)) real = join(root, real);
  const dir = mkdtempSync(join(tmpdir(), "ownership-gate-index-"));
  const tmp = join(dir, "index");
  try {
    if (exists(real)) {
      copyFileSync(real, tmp);
      // Keep the copy's mtime at (or just below) the real index's. Git's
      // "racy clean" check re-reads files modified at or after the index's
      // mtime; a fresh mtime would make git trust stale stat data and miss a
      // same-size edit made in the same second as the last index write.
      const st = statSync(real, { bigint: true });
      const t = Number(st.mtimeNs / 1_000_000n) / 1000 - 0.001;
      utimesSync(tmp, t, t);
    }
    const env = { GIT_INDEX_FILE: tmp };
    ensureRepoConfigIsInert(root);
    gitBytes(root, [...WORKTREE_SAFE, "add", "-A"], { env });
    return fn(env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function decodePath(raw: Buffer): string {
  try {
    return UTF8.decode(raw);
  } catch {
    throw new GateError(
      `File name ${JSON.stringify(raw.toString("latin1"))} is not valid UTF-8; the gate can't track it reliably. Rename it.`,
    );
  }
}

export function splitNul(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      out.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  out.push(buf.subarray(start));
  return out;
}
