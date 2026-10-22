#!/usr/bin/env node
// Generated from src/gate/ by build.mjs. Edit the source, then run `npm run build`.
// ownership-gate-version: 3
// ownership-gate-features: small-change

// src/gate/cli.ts
import { appendFileSync, readFileSync as readFileSync3, readSync as readSync2 } from "node:fs";

// src/gate/changes.ts
import { mkdtempSync as mkdtempSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join4 } from "node:path";

// src/gate/config.ts
import { join as join3 } from "node:path";

// src/gate/files.ts
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

// src/gate/shared.ts
import { fileURLToPath } from "node:url";
var GATE_VERSION = 3;
var LEARNING = ".learning";
var CHECKS_DIR = `${LEARNING}/checks`;
var CONFIG_PATH = `${LEARNING}/config.json`;
var GATE_REL = `${LEARNING}/gate.mjs`;
var REPORT_INPUT = `${LEARNING}/report.local.json`;
var ZERO_SHA = "0".repeat(40);
var REGULAR_MODES = ["100644", "100755"];
var GATE_FILES = [
  CONFIG_PATH,
  GATE_REL,
  ".github/workflows/ownership-check.yml",
  ".claude/settings.json",
  ".github/CODEOWNERS"
];
var GateError = class extends Error {
};
var SELF = (() => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return "";
  }
})();
var isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
var own = (o, k) => Object.hasOwn(o, k);
var get = (o, k) => Object.hasOwn(o, k) ? o[k] : void 0;
var dict = () => /* @__PURE__ */ Object.create(null);
var sorted = (xs) => [...xs].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
var splitLines = (s) => {
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
};
var today = () => {
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
var VERSION_RE = /^\/\/ ownership-gate-version: (\d+)/m;
var FEATURES_RE = /^\/\/ ownership-gate-features: (.*)$/m;

// src/gate/files.ts
var lstat = (p) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
var isSymlink = (p) => lstat(p)?.isSymbolicLink() ?? false;
var isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
var exists = (p) => existsSync(p);
var MAX_CONFIG_BYTES = 256 * 1024;
var MAX_REPORT_BYTES = 4 * 1024 * 1024;
function readSmall(path, limit) {
  const st = lstat(path);
  if (!st || st.isSymbolicLink() || !st.isFile())
    throw new GateError(`${basename(path)} must be a regular file, not a symlink or special file.`);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(limit + 1);
    let n = 0;
    for (; ; ) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > limit)
        throw new GateError(`${basename(path)} is larger than ${Math.floor(limit / 1024)} KB \u2014 refusing to read it.`);
    }
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const existingMode = (() => {
    try {
      return statSync(path).mode & 511;
    } catch {
      return null;
    }
  })();
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 438, flag: "wx" });
    if (existingMode !== null) chmodSync(tmp, existingMode);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw e;
  }
}

// src/gate/git.ts
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync as statSync2, utimesSync } from "node:fs";
import { devNull, homedir, tmpdir } from "node:os";
import { dirname as dirname2, isAbsolute, join as join2, resolve } from "node:path";
function gitEnv(extra) {
  const env = { ...process.env, GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
  delete env.GIT_DIFF_OPTS;
  let n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  if (!Number.isFinite(n) || n < 0) n = 0;
  env.GIT_CONFIG_COUNT = String(n + 1);
  env[`GIT_CONFIG_KEY_${n}`] = "core.fsmonitor";
  env[`GIT_CONFIG_VALUE_${n}`] = "false";
  return { ...env, ...extra ?? {} };
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    maxBuffer: 1 << 30,
    timeout: opts.timeout,
    windowsHide: true
  });
  if (r.error) {
    const err = r.error;
    if (err.code === "ENOENT") throw Object.assign(new Error(`${cmd}: not found`), { code: "ENOENT" });
    throw err;
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0) };
}
function gitBytes(root, args, opts = {}) {
  let r;
  try {
    r = run("git", args, { cwd: root, env: gitEnv(opts.env), input: opts.input });
  } catch (e) {
    throw new GateError(`Could not run git: ${e.message}`);
  }
  if ((opts.check ?? true) && r.status !== 0) {
    throw new GateError(`git ${args.slice(0, 3).join(" ")} failed: ${r.stderr.toString("utf8").trim()}`);
  }
  return r.stdout;
}
var git = (root, args, opts = {}) => gitBytes(root, args, opts).toString("utf8");
var gitOk = (root, args) => {
  try {
    return run("git", args, { cwd: root, env: gitEnv() }).status === 0;
  } catch {
    return false;
  }
};
function repoRoot(path) {
  let start = resolve((path || process.cwd()).replace(/^~(?=$|[/\\])/, homedir()));
  if (!exists(start)) throw new GateError(`Path does not exist: ${start}`);
  if (isFile(start)) start = dirname2(start);
  let out;
  try {
    out = run("git", ["rev-parse", "--show-toplevel"], { cwd: start, env: gitEnv() });
  } catch (e) {
    throw new GateError(`Could not run git: ${e.message}`);
  }
  const top = out.stdout.toString("utf8").trim();
  if (out.status !== 0 || !top) throw new GateError(`Not inside a git working tree: ${start}`);
  return resolve(top);
}
var refExists = (root, ref) => gitOk(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
var hasFile = (root, rev, rel) => gitOk(root, ["cat-file", "-e", `${rev}:${rel}`]);
function readBlob(root, sha) {
  try {
    const r = run("git", ["cat-file", "blob", sha], { cwd: root, env: gitEnv() });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}
function showSmall(root, rev, rel, limit) {
  const size = git(root, ["cat-file", "-s", `${rev}:${rel}`], { check: false }).trim();
  if (!/^\d+$/.test(size)) throw new GateError(`${rel} at ${rev} isn't readable.`);
  if (Number(size) > limit)
    throw new GateError(`${rel} at ${rev} is larger than ${Math.floor(limit / 1024)} KB \u2014 refusing to read it.`);
  return git(root, ["show", `${rev}:${rel}`]);
}
function resolveBase(root, cfg, base) {
  if (base) {
    if (!refExists(root, base))
      throw new GateError(`Base ref '${base}' not found. In CI, check out with fetch-depth: 0.`);
    return base;
  }
  const names = cfg.base ? [cfg.base] : [];
  const head = git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { check: false }).trim();
  if (head) names.push(head.replace(/^refs\/remotes\/origin\//, ""));
  names.push("main", "master");
  const candidates = [];
  for (const b of names) {
    if (b.includes("/") && ["origin", "upstream"].includes(b.split("/", 1)[0])) candidates.push(b);
    else candidates.push(`upstream/${b}`, `origin/${b}`, b);
  }
  for (const ref of candidates) if (refExists(root, ref)) return ref;
  throw new GateError('Could not find the base branch. Set "base" in .learning/config.json or pass --base.');
}
function currentBranch(root, branch) {
  if (branch) return branch;
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  const name = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { check: false }).trim();
  if (!name) throw new GateError("Detached HEAD: pass --branch <name>.");
  return name;
}
var WORKTREE_SAFE = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`];
function ensureRepoConfigIsInert(root) {
  if (process.env.OWNERSHIP_GATE_TRUST_REPO_CONFIG === "1") return;
  const out = git(root, ["config", "--show-scope", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"], {
    check: false
  });
  const local = /* @__PURE__ */ new Set();
  for (const line of splitLines(out)) {
    const parts = line.trim().split(/\s+/);
    if ((parts[0] === "local" || parts[0] === "worktree") && parts.length > 1) local.add(parts[1]);
  }
  if (local.size) {
    throw new GateError(
      `This repo's own .git/config defines filter commands (${sorted(local).join(", ")}) that git would run while the gate reads your changes. If you set these up yourself (e.g. git-crypt, or git-lfs installed with --local), rerun with OWNERSHIP_GATE_TRUST_REPO_CONFIG=1.`
    );
  }
}
function withWorktreeIndex(root, fn) {
  let real = git(root, ["rev-parse", "--git-path", "index"]).trim();
  if (!isAbsolute(real)) real = join2(root, real);
  const dir = mkdtempSync(join2(tmpdir(), "ownership-gate-index-"));
  const tmp = join2(dir, "index");
  try {
    if (exists(real)) {
      copyFileSync(real, tmp);
      const st = statSync2(real, { bigint: true });
      const t = Number(st.mtimeNs / 1000000n) / 1e3 - 1e-3;
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
var UTF8 = new TextDecoder("utf-8", { fatal: true });
function decodePath(raw) {
  try {
    return UTF8.decode(raw);
  } catch {
    throw new GateError(
      `File name ${JSON.stringify(raw.toString("latin1"))} is not valid UTF-8; the gate can't track it reliably. Rename it.`
    );
  }
}
function splitNul(buf) {
  const out = [];
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

// src/gate/glob.ts
function globToRegExp(pat) {
  const chars = [...pat];
  const n = chars.length;
  const res = [];
  const escapeOutside = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const escapeInSet = (c) => c.replace(/[\\\][^-]/g, "\\$&");
  let i = 0;
  while (i < n) {
    const c = chars[i++];
    if (c === "*") {
      if (res[res.length - 1] !== "[\\s\\S]*") res.push("[\\s\\S]*");
    } else if (c === "?") res.push("[\\s\\S]");
    else if (c === "[") {
      let j = i;
      if (j < n && chars[j] === "!") j++;
      if (j < n && chars[j] === "]") j++;
      while (j < n && chars[j] !== "]") j++;
      if (j >= n) {
        res.push("\\[");
        continue;
      }
      const negate = chars[i] === "!";
      const body = chars.slice(negate ? i + 1 : i, j);
      i = j + 1;
      const items = [];
      for (let k = 0; k < body.length; k++) {
        if (k + 2 < body.length && body[k + 1] === "-") {
          items.push([body[k], body[k + 2]]);
          k += 2;
        } else items.push([body[k], body[k]]);
      }
      const valid = items.filter(([lo, hi]) => lo.codePointAt(0) <= hi.codePointAt(0));
      if (!valid.length) {
        res.push(negate ? "[\\s\\S]" : "(?!)");
        continue;
      }
      const cls = valid.map(([lo, hi]) => lo === hi ? escapeInSet(lo) : `${escapeInSet(lo)}-${escapeInSet(hi)}`).join("");
      res.push(negate ? `[^${cls}]` : `[${cls}]`);
    } else res.push(escapeOutside(c));
  }
  return new RegExp(`^(?:${res.join("")})$`, "u");
}
var globCache = /* @__PURE__ */ new Map();
var globMatch = (path, pat) => {
  let re = globCache.get(pat);
  if (!re) {
    re = globToRegExp(pat);
    globCache.set(pat, re);
  }
  return re.test(path);
};
function matches(path, patterns) {
  for (const pat of patterns) {
    if (globMatch(path, pat)) return true;
    if (pat.startsWith("**/") && globMatch(path, pat.slice(3))) return true;
  }
  return false;
}

// src/gate/config.ts
var DEFAULT_CONFIG = {
  mode: "required",
  // required | suggested | off
  base: "",
  // empty = auto-detect (upstream/, origin/HEAD, main, master)
  sensitive: ["**/auth/**", "**/payments/**", "**/migrations/**", "**/security/**"],
  // "ignore" = no questions asked. Ignored files are still tracked: changing
  // them after a report makes it stale, like any other file.
  ignore: ["**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/poetry.lock", "**/Cargo.lock", "**/go.sum"],
  min_summary_chars: 80,
  // A change with at most this many added + removed lines (ignored files not
  // counted; nothing sensitive, binary or a submodule) needs only a summary of
  // small_summary_chars. 0 turns the fast path off.
  small_change_lines: 10,
  small_summary_chars: 30,
  skip_label: "skip-ownership-check"
};
function valueSource(raw, path) {
  let i = 0;
  let found = null;
  const ws = () => {
    while (" 	\n\r".includes(raw[i]) && i < raw.length) i++;
  };
  const str = () => {
    const start = i++;
    while (raw[i] !== '"') i += raw[i] === "\\" ? 2 : 1;
    return JSON.parse(raw.slice(start, ++i));
  };
  const skip = () => {
    if (raw[i] === '"') return void str();
    if (raw[i] !== "{" && raw[i] !== "[") {
      while (i < raw.length && !",]} 	\n\r".includes(raw[i])) i++;
      return;
    }
    let depth = 0;
    do {
      if (raw[i] === '"') {
        str();
        continue;
      }
      if (raw[i] === "{" || raw[i] === "[") depth++;
      else if (raw[i] === "}" || raw[i] === "]") depth--;
      i++;
    } while (depth > 0);
  };
  const walk = (depth) => {
    i++;
    ws();
    if (raw[i] === "}") return void i++;
    for (; ; ) {
      ws();
      const key = str();
      ws();
      i++;
      ws();
      if (key !== path[depth]) skip();
      else if (depth === path.length - 1) {
        const start = i;
        skip();
        found = raw.slice(start, i);
      } else {
        found = null;
        if (raw[i] === "{") walk(depth + 1);
        else skip();
      }
      ws();
      if (raw[i++] === "}") return;
    }
  };
  ws();
  if (raw[i] === "{") walk(0);
  return found;
}
function parseConfig(raw, where) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new GateError(`${where}: not valid JSON (${e.message}).`);
  }
  const section = isObj(data) ? isObj(data.ownership_check) ? data.ownership_check : "ownership_check" in data ? data.ownership_check : data : null;
  if (!isObj(section)) throw new GateError(`${where}: expected an object like {"ownership_check": {...}}.`);
  const cfg = { ...DEFAULT_CONFIG, ...section };
  if (!["required", "suggested", "off"].includes(cfg.mode))
    throw new GateError(`${where}: mode must be required, suggested or off.`);
  for (const key of ["sensitive", "ignore"]) {
    const v = cfg[key];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x))
      throw new GateError(`${where}: "${key}" must be a list of glob strings.`);
    for (const pat of v) {
      try {
        globMatch("", pat);
      } catch {
        throw new GateError(`${where}: "${key}" has a pattern that can't be used: ${JSON.stringify(pat)}.`);
      }
    }
  }
  for (const key of ["base", "skip_label"]) {
    if (typeof cfg[key] !== "string") throw new GateError(`${where}: "${key}" must be a string.`);
  }
  for (const key of ["min_summary_chars", "small_change_lines", "small_summary_chars"]) {
    const m = cfg[key];
    const literal = valueSource(raw, section === data ? [key] : ["ownership_check", key]);
    const floatLiteral = literal !== null && /[.eE]/.test(literal);
    if (typeof m !== "number" || !Number.isInteger(m) || m < 0 || floatLiteral)
      throw new GateError(`${where}: "${key}" must be a non-negative integer.`);
  }
  return { ...cfg, _configured: true };
}
var suggestedDefaults = () => ({ ...DEFAULT_CONFIG, mode: "suggested", _configured: false });
function loadConfig(root, rev) {
  if (rev) {
    if (!hasFile(root, rev, CONFIG_PATH)) return suggestedDefaults();
    return parseConfig(showSmall(root, rev, CONFIG_PATH, MAX_CONFIG_BYTES), `${CONFIG_PATH} at ${rev}`);
  }
  const path = join3(root, CONFIG_PATH);
  if (!lstat(path)) return suggestedDefaults();
  return parseConfig(readSmall(path, MAX_CONFIG_BYTES), CONFIG_PATH);
}
function rulesForVerify(root, baseRef) {
  if (hasFile(root, baseRef, CONFIG_PATH))
    return parseConfig(showSmall(root, baseRef, CONFIG_PATH, MAX_CONFIG_BYTES), `${CONFIG_PATH} on ${baseRef}`);
  return { ...DEFAULT_CONFIG, _configured: false };
}
function rulesForLocal(root, baseRef) {
  if (hasFile(root, baseRef, CONFIG_PATH)) return rulesForVerify(root, baseRef);
  return loadConfig(root);
}
function isSensitive(path, mode, cfg) {
  if (mode === "160000") return true;
  return matches(path, cfg.sensitive) || matches(`${path}/_`, cfg.sensitive);
}
var noQuestions = (path, mode, cfg) => matches(path, cfg.ignore) && !isSensitive(path, mode, cfg);

// src/gate/changes.ts
var PLUMBING_RE = /^\.learning\/(checks\/[^/]+\.md|decisions\/[^/]+\.md|map\.md|[^/]+\.local\.md)$/;
function isPlumbing(path, mode = "100644") {
  if (GATE_FILES.includes(path)) return true;
  if (path === REPORT_INPUT) return mode === "100644";
  return PLUMBING_RE.test(path) && (mode === "100644" || mode === "000000");
}
function isReportIgnoreEdit(root, path, c) {
  if (path !== ".gitignore" || c.mode !== "100644") return false;
  const before = c.base === ZERO_SHA ? Buffer.alloc(0) : c.base_mode === "100644" ? readBlob(root, c.base) : null;
  const after = readBlob(root, c.blob);
  if (!before || !after) return false;
  return after.equals(withIgnoreLine(before));
}
function withIgnoreLine(text) {
  const sep2 = text.length && text[text.length - 1] !== 10 ? "\n" : "";
  return Buffer.concat([text, Buffer.from(`${sep2}${REPORT_INPUT}
`)]);
}
function collectChanges(root, base, rev) {
  const target = rev || "HEAD";
  if (!refExists(root, target)) throw new GateError("This branch has no commits yet \u2014 commit something first.");
  const mb = git(root, ["merge-base", base, target], { check: false }).trim();
  if (!mb)
    throw new GateError(`No common history between ${base} and ${target}. In CI, check out with fetch-depth: 0.`);
  const rawArgs = ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--ignore-submodules=none"];
  let raw;
  let untracked = /* @__PURE__ */ new Set();
  if (rev) raw = gitBytes(root, [...rawArgs, mb, rev]);
  else {
    raw = withWorktreeIndex(root, (env) => gitBytes(root, [...rawArgs, "--cached", mb], { env }));
    const out = gitBytes(root, [...WORKTREE_SAFE, "ls-files", "--others", "--exclude-standard", "-z"]);
    untracked = new Set(
      splitNul(out).filter((p) => p.length).map(decodePath)
    );
  }
  const fields = splitNul(raw);
  const changes = dict();
  let i = 0;
  while (i < fields.length - 1) {
    const meta = fields[i].toString("latin1");
    if (!meta.startsWith(":")) {
      i++;
      continue;
    }
    const [oldmode, newmode, oldsha, newsha] = meta.slice(1).split(/\s+/);
    const path = decodePath(fields[i + 1]);
    i += 2;
    const change = { mode: newmode, blob: newsha, base: oldsha, base_mode: oldmode };
    if (!isPlumbing(path, newmode) && !isReportIgnoreEdit(root, path, change)) changes[path] = change;
  }
  return [Object.fromEntries(sorted(Object.keys(changes)).map((k) => [k, changes[k]])), untracked, mb];
}
function merge3(ours, base, theirs) {
  const dir = mkdtempSync2(join4(tmpdir2(), "ownership-gate-merge-"));
  try {
    const paths = [
      ["ours", ours],
      ["base", base],
      ["theirs", theirs]
    ].map(([name, data]) => {
      const p = join4(dir, name);
      writeFileSync2(p, data);
      return p;
    });
    const r = run("git", ["merge-file", "-p", "-q", ...paths], { cwd: dir, env: gitEnv() });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  } finally {
    rmSync2(dir, { recursive: true, force: true });
  }
}
var isChange = (v) => isObj(v) && ["mode", "blob", "base", "base_mode"].every((k) => typeof v[k] === "string");
function matchKind(root, verified, current) {
  if (!isChange(verified)) return null;
  if (verified.mode === current.mode && verified.blob === current.blob && verified.base === current.base && verified.base_mode === current.base_mode)
    return "exact";
  const expectedMode = verified.mode === verified.base_mode ? current.base_mode : verified.mode;
  if (current.mode !== expectedMode) return null;
  if (verified.base === current.base) return current.blob === verified.blob ? "merged" : null;
  if (!REGULAR_MODES.includes(current.mode) || !REGULAR_MODES.includes(verified.mode)) return null;
  if ([verified.blob, verified.base, current.base, current.blob].includes(ZERO_SHA)) return null;
  const blobs = [verified.blob, verified.base, current.base, current.blob].map((s) => readBlob(root, s));
  if (blobs.some((b) => b === null)) return null;
  const [vBlob, vBase, cBase, cBlob] = blobs;
  if (blobs.some((b) => b.subarray(0, 8e3).includes(0))) return null;
  const merged = merge3(vBlob, vBase, cBase);
  return merged?.equals(cBlob) ? "merged" : null;
}
function branchBlobs(root, target, mb) {
  const out = git(root, ["rev-list", "--objects", target, "--not", mb], { check: false });
  return new Set(
    splitLines(out).filter(Boolean).map((l) => l.split(" ", 1)[0])
  );
}
var SAME = ["ok", "rebased"];
function states(root, changes, old, target, mb) {
  const oldFiles = old ? old.files : dict();
  let reachable = null;
  const out = dict();
  for (const [p, c] of Object.entries(changes)) {
    if (!own(oldFiles, p)) {
      out[p] = "new";
      continue;
    }
    const kind = matchKind(root, get(oldFiles, p), c);
    if (kind === "exact") out[p] = "ok";
    else if (kind === "merged") {
      reachable ??= branchBlobs(root, target, mb);
      out[p] = reachable.has(get(oldFiles, p).blob) ? "ok" : "rebased";
    } else out[p] = "stale";
  }
  return out;
}
function needsVerification(changes, st, old, cfg) {
  const oldVerified = old ? old.verified : dict();
  const out = [];
  for (const [path, c] of Object.entries(changes)) {
    if (noQuestions(path, c.mode, cfg)) continue;
    if (SAME.includes(st[path]) && get(oldVerified, path)?.length) continue;
    if (isSensitive(path, c.mode, cfg) || old !== null && !SAME.includes(st[path])) out.push(path);
  }
  return out;
}
function baseGateHas(root, baseRef, feature) {
  if (!hasFile(root, baseRef, GATE_REL)) return false;
  try {
    const head = showSmall(root, baseRef, GATE_REL, 8 * 1024 * 1024).slice(0, 4096);
    return (FEATURES_RE.exec(head)?.[1] ?? "").trim().split(/\s+/).includes(feature);
  } catch {
    return false;
  }
}
function changedLines(root, mb, rev, paths) {
  const args = [
    "diff",
    "--numstat",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--diff-algorithm=myers",
    "--ignore-submodules=none"
  ];
  const raw = rev ? gitBytes(root, [...args, mb, rev]) : withWorktreeIndex(root, (env) => gitBytes(root, [...args, "--cached", mb], { env }));
  let total = 0;
  for (const rec of splitNul(raw)) {
    const t1 = rec.indexOf(9);
    const t2 = t1 < 0 ? -1 : rec.indexOf(9, t1 + 1);
    if (t2 < 0 || !paths.has(decodePath(rec.subarray(t2 + 1)))) continue;
    const added = rec.subarray(0, t1).toString("latin1");
    const removed = rec.subarray(t1 + 1, t2).toString("latin1");
    if (added === "-" || removed === "-") return null;
    total += Number(added) + Number(removed);
  }
  return total;
}
var changedLinesText = (n) => `${n} changed line${n === 1 ? "" : "s"}`;
function smallChange(root, baseRef, mb, rev, changes, cfg) {
  const no = (lines2 = null, note = null) => ({ small: false, lines: lines2, note });
  const entries = Object.entries(changes);
  if (!cfg.small_change_lines || !entries.length) return no();
  if (entries.some(([p, c]) => isSensitive(p, c.mode, cfg) || c.base_mode === "160000")) return no();
  const counted = new Set(entries.filter(([p]) => !matches(p, cfg.ignore)).map(([p]) => p));
  const lines = changedLines(root, mb, rev, counted);
  if (lines === null || lines > cfg.small_change_lines) return no(lines);
  if (!baseGateHas(root, baseRef, "small-change")) {
    return no(
      lines,
      `This would count as a small change (${changedLinesText(lines)}), but the base branch's gate predates the fast path, so CI would ask for the full check. Upgrade it with \`gate.mjs install --upgrade\` in its own PR.`
    );
  }
  return { small: true, lines, note: null };
}

// src/gate/report.ts
import { join as join5 } from "node:path";
var DATA_MARKER = "<!-- ownership-data: generated by the ownership gate; do not edit by hand -->";
function stableJson(value, indent) {
  const sortDeep = (v) => Array.isArray(v) ? v.map(sortDeep) : isObj(v) ? Object.fromEntries(sorted(Object.keys(v)).map((k) => [k, sortDeep(v[k])])) : v;
  return JSON.stringify(sortDeep(value), null, indent);
}
function quoteAll(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
var reportRelpath = (branch) => `${CHECKS_DIR}/${quoteAll(branch)}.md`;
function renderReport(data) {
  const lines = [
    `# Ownership check \u2014 ${data.branch}`,
    `Date: ${data.date} \xB7 Base: ${data.base} \xB7 Gate v${data.version}`,
    "",
    "## Summary (in the developer's own words)",
    data.summary.trim(),
    "",
    "## Verified understanding"
  ];
  for (const path of sorted(Object.keys(data.verified)))
    lines.push(`- \`${path}\` \u2014 ${(get(data.verified, path) ?? []).join("; ")}`);
  const unverified = sorted(Object.keys(data.files).filter((p) => !own(data.verified, p)));
  if (unverified.length)
    lines.push(
      "",
      `Also in this change (reviewed, no specific questions): ${unverified.map((p) => `\`${p}\``).join(", ")}`
    );
  lines.push("", DATA_MARKER, "```json", stableJson(data, 1), "```", "");
  return lines.join("\n");
}
function extractData(text) {
  const after = text.split(DATA_MARKER).slice(1).join(DATA_MARKER);
  const m = /```json\n([\s\S]*?)\n```/.exec(after);
  return m ? m[1] : null;
}
function parseReport(text) {
  if (!text.includes(DATA_MARKER))
    throw new GateError("Report is missing its data block \u2014 run the check again to regenerate it.");
  const block = extractData(text);
  if (block === null) throw new GateError("Report data block is malformed \u2014 run the check again to regenerate it.");
  let data;
  try {
    data = JSON.parse(block);
  } catch (e) {
    throw new GateError(`Report data is not valid JSON (${e.message}) \u2014 run the check again.`);
  }
  if (!(isObj(data) && isObj(data.files) && isObj(data.verified) && typeof data.summary === "string")) {
    throw new GateError("Report data has the wrong shape \u2014 run the check again to regenerate it.");
  }
  for (const v of Object.values(data.verified)) {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
      throw new GateError("Report data has the wrong shape \u2014 run the check again to regenerate it.");
  }
  if (data.version !== GATE_VERSION) {
    throw new GateError(
      `Report was made by gate v${String(data.version)}; this gate is v${GATE_VERSION}. If your branch is behind the base, merge it first; then run the check again.`
    );
  }
  return data;
}
function readReport(root, branch, rev) {
  const rel = reportRelpath(branch);
  if (rev) {
    if (!hasFile(root, rev, rel)) return null;
    return parseReport(showSmall(root, rev, rel, MAX_REPORT_BYTES));
  }
  const path = join5(root, rel);
  return lstat(path) ? parseReport(readSmall(path, MAX_REPORT_BYTES)) : null;
}
var unusable = (e) => [
  { files: {}, verified: {}, summary: "", _outdated: true },
  `Existing report can't be used (${e.message}); its files need verifying again.`
];
function parseLenient(text) {
  try {
    return [parseReport(text), null];
  } catch (e) {
    let files = {};
    if (text.includes(DATA_MARKER)) {
      try {
        const data = JSON.parse(extractData(text) ?? "null");
        if (isObj(data) && isObj(data.files)) files = data.files;
      } catch {
      }
    }
    return [
      { files, verified: {}, summary: "", _outdated: true },
      `Existing report can't be used (${e.message}); its files need verifying again.`
    ];
  }
}
function previousReport(root, branch, baseRef) {
  const rel = reportRelpath(branch);
  const path = join5(root, rel);
  if (lstat(path)) {
    try {
      return parseLenient(readSmall(path, MAX_REPORT_BYTES));
    } catch (e) {
      return unusable(e);
    }
  }
  const mb = git(root, ["merge-base", baseRef, "HEAD"], { check: false }).trim();
  if (mb) {
    for (const commit of git(root, ["rev-list", `${mb}..HEAD`, "--", rel], { check: false }).split(/\s+/).filter(Boolean)) {
      for (const rev of [commit, `${commit}^`]) {
        if (hasFile(root, rev, rel)) {
          const [report, note] = parseLenient(showSmall(root, rev, rel, MAX_REPORT_BYTES));
          return [report, note ?? "Using the last committed report (the file was removed)."];
        }
      }
    }
  }
  return [null, null];
}
function uncommittedReport(root) {
  try {
    const rel = reportRelpath(currentBranch(root));
    const saved = stableJson(parseReport(readSmall(join5(root, rel), MAX_REPORT_BYTES)));
    if (!hasFile(root, "HEAD", rel)) return rel;
    let committed = null;
    try {
      committed = stableJson(parseReport(showSmall(root, "HEAD", rel, MAX_REPORT_BYTES)));
    } catch {
    }
    return saved === committed ? null : rel;
  } catch {
    return null;
  }
}

// src/gate/ci-summary.ts
function mdSafe(text) {
  let t = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  for (const ch of ["\\", "[", "]", "|", "`", "*", "_"]) t = t.split(ch).join(`\\${ch}`);
  return t;
}
function jobSummary(root, branch, rev, base, passed, messages, mode) {
  const icon = passed ? "\u2705" : mode === "required" ? "\u274C" : "\u26A0\uFE0F";
  const title = mode === "off" ? "Ownership check is off" : mode === "skipped" ? "Ownership check skipped by label" : passed ? "Ownership check passed" : "Ownership check failed";
  const out = [`## ${icon} ${title}`, ""];
  if (messages.length) out.push(...messages.map((m) => `- ${mdSafe(m)}`), "");
  let report = null;
  try {
    report = readReport(root, branch, rev);
  } catch {
    report = null;
  }
  if (report) {
    let cfg = DEFAULT_CONFIG;
    try {
      cfg = rulesForVerify(root, resolveBase(root, loadConfig(root, rev), base));
    } catch {
    }
    out.push(
      "### The developer's summary",
      "",
      ...splitLines(report.summary.trim()).map((l) => `> ${mdSafe(l)}`),
      "",
      "### Verified understanding",
      "",
      "| File | Concepts the developer explained |",
      "|---|---|"
    );
    for (const path of sorted(Object.keys(report.verified))) {
      const entry = get(report.files, path);
      const mode2 = isObj(entry) && typeof entry.mode === "string" ? entry.mode : "100644";
      const tag = isSensitive(path, mode2, cfg) ? " \u{1F512}" : "";
      out.push(`| ${mdSafe(path)}${tag} | ${(get(report.verified, path) ?? []).map(mdSafe).join("; ")} |`);
    }
    const rest = sorted(Object.keys(report.files).filter((p) => !own(report.verified, p)));
    if (rest.length)
      out.push(
        "",
        `<details><summary>Also in this change, no specific questions (${rest.length})</summary>`,
        "",
        ...rest.map((p) => `- ${mdSafe(p)}`),
        "",
        "</details>"
      );
    out.push(
      "",
      `<sub>\u{1F512} sensitive \xB7 report: \`${reportRelpath(branch)}\` \xB7 gate v${GATE_VERSION}. The report shows what was verified, never scores or mistakes.</sub>`
    );
  }
  return `${out.join("\n")}
`.slice(0, 6e4);
}
function ci(kind, messages) {
  if (process.env.GITHUB_ACTIONS === "true")
    for (const m of messages) process.stdout.write(`::${kind} title=Ownership check::${m}
`);
}

// src/gate/commands.ts
import { realpathSync, unlinkSync as unlinkSync2 } from "node:fs";
import { basename as basename2, dirname as dirname3, join as join6, resolve as resolve2 } from "node:path";
var CHECK_ME_HINT = 'Ask Claude to run the ownership check ("check me"), then commit the report.';
var BLANK = "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
var BLANK_ENDS = new RegExp(`^${BLANK}+|${BLANK}+$`, "gu");
var trimSummary = (s) => s.replace(BLANK_ENDS, "");
var charCount = (s) => [...s].length;
function status(repo, base, branch) {
  const root = repoRoot(repo);
  const baseRef = resolveBase(root, loadConfig(root), base);
  const cfg = rulesForLocal(root, baseRef);
  const br = currentBranch(root, branch);
  const [changes, untracked, mb] = collectChanges(root, baseRef, null);
  const [report, note] = previousReport(root, br, baseRef);
  const st = states(root, changes, report, "HEAD", mb);
  const oldVerified = report ? report.verified : dict();
  const files = Object.entries(changes).map(([p, c]) => ({
    path: p,
    state: st[p],
    sensitive: isSensitive(p, c.mode, cfg),
    ignored: matches(p, cfg.ignore),
    untracked: untracked.has(p),
    verified: Boolean(get(oldVerified, p)?.length) && SAME.includes(st[p])
  }));
  const notes = note ? [note] : [];
  if (Object.values(st).includes("rebased")) {
    notes.push(
      "Some verified files were rebased: save the report again (no new questions needed), or CI won't be able to match them."
    );
  }
  const localGate = join6(root, GATE_REL);
  if (isFile(localGate) && !isSymlink(localGate)) {
    let head = "";
    try {
      head = readSmall(localGate, 8 * 1024 * 1024).slice(0, 4096);
    } catch {
    }
    const v = VERSION_RE.exec(head);
    if (v && Number(v[1]) !== GATE_VERSION) {
      notes.push(
        `This repo's ${GATE_REL} is v${v[1]} but the running gate is v${GATE_VERSION}. CI runs the base branch's copy, so update whichever is older (the plugin, or \`gate.mjs install --upgrade\` in a PR).`
      );
    }
  }
  if (exists(localGate) && hasFile(root, baseRef, GATE_REL)) {
    let head = "";
    try {
      head = showSmall(root, baseRef, GATE_REL, 8 * 1024 * 1024).slice(0, 4096);
    } catch {
    }
    const v = VERSION_RE.exec(head);
    if (v && Number(v[1]) !== GATE_VERSION) {
      notes.push(
        `The base branch runs gate v${v[1]} but this one is v${GATE_VERSION}: merge the base branch first, or CI will reject the report.`
      );
    }
  }
  const small = smallChange(root, baseRef, mb, null, changes, cfg);
  if (small.note) notes.push(small.note);
  return {
    mode: cfg.mode,
    configured: cfg._configured,
    base: baseRef,
    branch: br,
    report: reportRelpath(br),
    report_exists: report !== null,
    files,
    must_verify: needsVerification(changes, st, report, cfg),
    small_change: small.small,
    changed_lines: small.lines,
    min_summary_chars: small.small ? cfg.small_summary_chars : cfg.min_summary_chars,
    notes
  };
}
function formatStatus(s) {
  const mode = s.mode + (s.configured ? "" : ", no .learning/config.json");
  const lines = [`Ownership check \u2014 branch ${s.branch} vs ${s.base} (mode: ${mode})`];
  if (!s.files.length) return [lines[0], "No changes \u2014 nothing to check.", ...s.notes].join("\n");
  lines.push(`Report: ${s.report} (${s.report_exists ? "exists" : "not yet saved"})`);
  for (const f of s.files) {
    const tags = [
      f.state,
      ...["sensitive", "ignored", "untracked", "verified"].filter((t) => f[t]).map((t) => t === "sensitive" ? "SENSITIVE" : t)
    ];
    lines.push(`- ${f.path} [${tags.join(", ")}]`);
  }
  if (s.must_verify.length) lines.push(`Must be verified before saving: ${s.must_verify.join(", ")}`);
  if (s.small_change) {
    lines.push(
      `Small change (${changedLinesText(s.changed_lines ?? 0)}): one question is enough, and the summary needs at least ${s.min_summary_chars} characters.`
    );
  }
  lines.push(...s.notes);
  return lines.join("\n");
}
function save(payload, repo, base, branch) {
  const root = repoRoot(repo);
  const baseRef = resolveBase(root, loadConfig(root), base);
  const cfg = rulesForLocal(root, baseRef);
  const br = currentBranch(root, branch);
  const [changes, untracked, mb] = collectChanges(root, baseRef, null);
  if (!Object.keys(changes).length) throw new GateError(`No changes vs ${baseRef} \u2014 nothing to report.`);
  const summary = trimSummary(String(payload.summary ?? ""));
  const len = charCount(summary);
  const minChars = len < cfg.min_summary_chars && smallChange(root, baseRef, mb, null, changes, cfg).small ? cfg.small_summary_chars : cfg.min_summary_chars;
  if (len < minChars) {
    throw new GateError(
      `The summary must be the developer's own description of what changed, why, and what could break \u2014 at least ${minChars} characters.`
    );
  }
  const rawVerified = payload.verified ?? {};
  if (!isObj(rawVerified)) throw new GateError('"verified" must map file paths to lists of concepts.');
  const verified = dict();
  for (const [path, concepts0] of Object.entries(rawVerified)) {
    const concepts = typeof concepts0 === "string" ? [concepts0] : Array.isArray(concepts0) ? concepts0 : [];
    const items = concepts.map((c) => String(c).trim()).filter(Boolean);
    if (items.length) verified[String(path).trim().replace(/^\.\//, "")] = items;
  }
  const unknown = sorted(Object.keys(verified).filter((p) => !own(changes, p)));
  if (unknown.length)
    throw new GateError(
      `Not part of this change: ${unknown.join(", ")}. Changed files: ${Object.keys(changes).join(", ")}`
    );
  const [old] = previousReport(root, br, baseRef);
  const st = states(root, changes, old, "HEAD", mb);
  const missing = needsVerification(changes, st, old, cfg).filter((p) => !own(verified, p));
  if (missing.length)
    throw new GateError(
      `Still needs verification (sensitive, or new/changed since the last report): ${missing.join(", ")}`
    );
  if (old) {
    for (const [p, concepts] of Object.entries(old.verified)) {
      if (own(changes, p) && SAME.includes(st[p]) && !own(verified, p)) verified[p] = concepts;
    }
  }
  const askable = Object.entries(changes).filter(([p, c]) => !noQuestions(p, c.mode, cfg));
  if (askable.length && !Object.keys(verified).length)
    throw new GateError("No verified files \u2014 the check needs at least one area the developer explained.");
  const data = { version: GATE_VERSION, branch: br, base: baseRef, date: today(), summary, verified, files: changes };
  const rel = reportRelpath(br);
  atomicWrite(join6(root, rel), renderReport(data));
  const extra = sorted([...untracked].filter((p) => own(changes, p)));
  const note = extra.length ? ` Untracked files included: ${extra.join(", ")} \u2014 commit them too, or they'll show as changed.` : "";
  const n = Object.keys(changes).length;
  return `Saved ${rel}: ${n} file${n === 1 ? "" : "s"} fingerprinted, ${Object.keys(verified).length} verified. Commit it together with the code.${note}`;
}
function verify(repo, base, branch, rev = "HEAD", labels = []) {
  const root = repoRoot(repo);
  const baseRef = resolveBase(root, loadConfig(root, rev), base);
  const cfg = rulesForVerify(root, baseRef);
  if (cfg.mode === "off") return [true, [], "off"];
  if (labels.includes(cfg.skip_label)) return [true, [`Skipped by the '${cfg.skip_label}' label.`], "skipped"];
  const br = currentBranch(root, branch);
  const [changes, , mb] = collectChanges(root, baseRef, rev);
  if (!Object.keys(changes).length) return [true, [], cfg.mode];
  const report = readReport(root, br, rev);
  if (report === null) {
    if (Object.entries(changes).every(([p, c]) => noQuestions(p, c.mode, cfg)))
      return [true, ["Only ignored files changed (e.g. lockfiles) \u2014 no report needed."], cfg.mode];
    return [false, [`No ownership report for branch '${br}' (${reportRelpath(br)}). ${CHECK_ME_HINT}`], cfg.mode];
  }
  const st = states(root, changes, report, rev, mb);
  const by = (s) => Object.keys(changes).filter((p) => st[p] === s);
  const problems = [];
  const unverifiedSensitive = Object.entries(changes).filter(([p, c]) => isSensitive(p, c.mode, cfg) && !get(report.verified, p)?.length).map(([p]) => p);
  if (by("new").length) problems.push(`Changed after the check (not in the report): ${by("new").join(", ")}`);
  if (by("stale").length)
    problems.push(`Changed after the check (differs from what was verified): ${by("stale").join(", ")}`);
  if (by("rebased").length)
    problems.push(
      `Verified before a rebase \u2014 save the report again, no new questions needed: ${by("rebased").join(", ")}`
    );
  if (unverifiedSensitive.length)
    problems.push(`Sensitive files not explicitly verified: ${unverifiedSensitive.join(", ")}`);
  const len = charCount(trimSummary(report.summary));
  const shortOk = () => len >= cfg.small_summary_chars && smallChange(root, baseRef, mb, rev, changes, cfg).small;
  if (len < cfg.min_summary_chars && !shortOk()) problems.push("The developer's summary is missing or too short.");
  if (problems.length && !(by("rebased").length && problems.length === 1)) problems.push(CHECK_ME_HINT);
  return [problems.length === 0, problems, cfg.mode];
}
function removeReportInput(input, repo) {
  try {
    const abs = resolve2(input);
    const root = realpathSync(repoRoot(repo));
    if (join6(realpathSync(dirname3(abs)), basename2(abs)) !== join6(root, REPORT_INPUT)) return "";
    unlinkSync2(abs);
    return ` Removed ${REPORT_INPUT}.`;
  } catch {
    return "";
  }
}

// src/gate/hooks.ts
import { createHash } from "node:crypto";
import { chmodSync as chmodSync2, mkdirSync as mkdirSync2, readFileSync, realpathSync as realpathSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { isAbsolute as isAbsolute2, join as join7, relative, resolve as resolve3, sep } from "node:path";

// src/gate/push-detect.ts
var WRAPPERS = /* @__PURE__ */ new Set(["sudo", "doas", "env", "command", "builtin", "exec", "time", "nohup", "nice", "stdbuf"]);
var WRAPPER_ARG_OPTS = /* @__PURE__ */ new Set(["-u", "-g", "-C", "-h", "-p", "-n", "-f", "-o", "-i", "-e"]);
var SHELLS = /* @__PURE__ */ new Set(["bash", "sh", "zsh", "dash", "ksh"]);
var GIT_ARG_OPTS = /* @__PURE__ */ new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
var GH_ARG_OPTS = /* @__PURE__ */ new Set(["-R", "--repo", "--hostname"]);
var PUNCT = "();<>|&";
function tokenize(command) {
  const tokens = [];
  let cur = "";
  let inWord = false;
  let i = 0;
  const flush = () => {
    if (inWord) tokens.push(cur);
    cur = "";
    inWord = false;
  };
  while (i < command.length) {
    const c = command[i];
    if (c === " " || c === "	" || c === "\r" || c === "\n") {
      flush();
      i++;
    } else if (PUNCT.includes(c)) {
      flush();
      let j = i;
      while (j < command.length && PUNCT.includes(command[j])) j++;
      tokens.push(command.slice(i, j));
      i = j;
    } else if (c === "#" && !inWord) {
      while (i < command.length && command[i] !== "\n") i++;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (c === '"') {
      i++;
      inWord = true;
      for (; ; ) {
        if (i >= command.length) return null;
        const d = command[i];
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\" && i + 1 < command.length && '\\"$`\n'.includes(command[i + 1])) {
          cur += command[i + 1];
          i += 2;
        } else {
          cur += d;
          i++;
        }
      }
    } else if (c === "\\") {
      if (i + 1 < command.length) cur += command[i + 1];
      inWord = true;
      i += 2;
    } else {
      cur += c;
      inWord = true;
      i++;
    }
  }
  flush();
  return tokens;
}
function segments(command) {
  command = command.replace(/\\\n/g, " ").replace(/\n/g, ";");
  const tokens = tokenize(command) ?? command.split(/\s+/).filter(Boolean);
  const segs = [];
  let seg = [];
  for (const tok of tokens) {
    if (tok && [...tok].every((c) => ";&|()".includes(c))) {
      segs.push(seg);
      seg = [];
    } else seg.push(tok);
  }
  segs.push(seg);
  return segs.filter((s) => s.length);
}
var programName = (t) => t.split("/").pop() ?? t;
function isPushCommand(command, depth = 0) {
  if (depth > 3) return false;
  for (let tokens of segments(command)) {
    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (["{", "}", "!"].includes(tok) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) i++;
      else if (WRAPPERS.has(programName(tok))) {
        i++;
        while (i < tokens.length && tokens[i].startsWith("-")) i += WRAPPER_ARG_OPTS.has(tokens[i]) ? 2 : 1;
      } else break;
    }
    tokens = tokens.slice(i);
    if (!tokens.length) continue;
    const prog = programName(tokens[0]);
    if (SHELLS.has(prog)) {
      for (let j = 1; j < tokens.length - 1; j++) {
        const t = tokens[j];
        if (t.startsWith("-") && !t.startsWith("--") && t.slice(1).includes("c")) {
          if (isPushCommand(tokens[j + 1], depth + 1)) return true;
          break;
        }
      }
    } else if (prog === "git") {
      let j = 1;
      while (j < tokens.length && tokens[j].startsWith("-")) j += GIT_ARG_OPTS.has(tokens[j]) ? 2 : 1;
      if (j < tokens.length && tokens[j] === "push") return true;
    } else if (prog === "gh") {
      let j = 1;
      while (j < tokens.length && tokens[j].startsWith("-")) j += GH_ARG_OPTS.has(tokens[j]) ? 2 : 1;
      if (tokens[j] === "pr" && j + 1 < tokens.length && ["create", "merge"].includes(tokens[j + 1])) return true;
    }
  }
  return false;
}

// src/gate/hooks.ts
function projectHasGateHook(root) {
  try {
    const settings = JSON.parse(readSmall(join7(root, ".claude", "settings.json"), MAX_CONFIG_BYTES));
    const groups = settings?.hooks?.PreToolUse ?? [];
    return groups.some(
      (g) => (g.hooks ?? []).some((h) => (h.command ?? "").includes("gate.mjs") && (h.command ?? "").includes("claude-hook"))
    );
  } catch {
    return false;
  }
}
function claudeHook(stdinText, fromPlugin = false) {
  let root;
  try {
    const payload = JSON.parse(stdinText || "{}");
    const command = String(payload?.tool_input?.command ?? "");
    if ((payload?.tool_name ?? "Bash") !== "Bash" || !isPushCommand(command)) return 0;
    root = repoRoot(payload?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (!lstat(join7(root, CONFIG_PATH))) return 0;
    if (fromPlugin && projectHasGateHook(root)) return 0;
  } catch {
    return 0;
  }
  let passed, problems, mode;
  try {
    [passed, problems, mode] = verify(root);
  } catch (e) {
    if (!(e instanceof GateError)) return 0;
    [passed, problems, mode] = [false, [e.message], "required"];
  }
  if (passed || mode !== "required") return 0;
  const pending = uncommittedReport(root);
  if (pending) {
    process.stderr.write(
      `Blocked by the ownership gate: the report ${pending} is saved but not committed. Commit it first, then push as a separate command. This hook checks the branch before a command runs, so a push in the same command as the commit is blocked too.
`
    );
    return 2;
  }
  process.stderr.write(`Blocked by the ownership gate:
- ${problems.join("\n- ")}
`);
  return 2;
}
var MIN_NODE = 20;
var NODE_NOTE = "Tell the user in one line that Comprende needs Node.js 20 or newer (install it from https://nodejs.org), then a restart of Claude Code.";
var ALWAYS_ON = "Comprende is installed. Whenever you write or change code in this session, follow the comprende skill: explain only what's new, non-obvious, risky or a real decision, briefly, in the user's language and dialect.";
function sessionStart(stdinText) {
  const lines = [];
  const node = process.versions.node;
  if (Number.parseInt(node, 10) < MIN_NODE)
    lines.push(`Comprende is running on Node.js ${node}, which is too old. ${NODE_NOTE}`);
  if (process.env.COMPRENDE_QUIET !== "1") lines.push(ALWAYS_ON);
  lines.push(...gateContext(stdinText));
  return lines.length ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join(" ") } } : {};
}
function gateContext(stdinText) {
  try {
    const payload = JSON.parse(stdinText || "{}");
    const root = repoRoot(payload?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (!lstat(join7(root, CONFIG_PATH))) return [];
    const cfg = loadConfig(root);
    if (cfg.mode === "off") return [];
    const lines = [
      `This repository uses the ownership gate (mode: ${cfg.mode}). For any code change, follow the comprende skill's ownership check (read references/ownership-check.md): brief in-flight questions, a final check before commit/PR, and a saved report.`
    ];
    const repoGate = join7(root, GATE_REL);
    if (process.env.OWNERSHIP_GATE_NO_AUTO_HOOK !== "1" && isFile(repoGate) && !isSymlink(repoGate)) {
      if (!SELF || !readFileSync(repoGate).equals(readFileSync(SELF))) {
        lines.push(
          `This repo's ${GATE_REL} differs from the plugin's copy, so the local pre-push hook was NOT installed automatically. If the user trusts this repo, they can run \`node ${GATE_REL} install-hooks\`; mention this in one line.`
        );
      } else {
        const result = installHooks(root, true)[0];
        if (result.startsWith("installed") || result.startsWith("re-pinned")) {
          lines.push(
            "The local pre-push git hook was just installed in this clone; mention it to the user in one line (set OWNERSHIP_GATE_NO_AUTO_HOOK=1 to opt out)."
          );
        } else if (result.startsWith("SKIPPED")) lines.push(`The gate's pre-push hook wasn't added: ${result}`);
      }
    }
    return lines;
  } catch {
    return [];
  }
}
function prePush(stdinText, repo) {
  let root, baseBranch;
  try {
    root = repoRoot(repo);
    const b = resolveBase(root, loadConfig(root), null);
    baseBranch = b.includes("/") ? b.slice(b.indexOf("/") + 1) : b;
  } catch {
    return 0;
  }
  let failed = false;
  for (const line of splitLines(stdinText)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) continue;
    const [, localSha, remoteRef] = parts;
    if (localSha === ZERO_SHA || !remoteRef.startsWith("refs/heads/")) continue;
    const branch = remoteRef.slice("refs/heads/".length);
    if (branch === baseBranch) continue;
    let passed, problems, mode;
    try {
      [passed, problems, mode] = verify(root, null, branch, localSha);
    } catch (e) {
      if (!(e instanceof GateError) && e.code) {
        process.stderr.write(`ownership gate: skipped (${e.message})
`);
        continue;
      }
      [passed, problems, mode] = [false, [e.message], "required"];
    }
    if (passed) continue;
    const label = mode === "required" ? "blocked" : "warning";
    process.stderr.write(`
Ownership gate ${label} for '${branch}':
- ${problems.join("\n- ")}
`);
    failed ||= mode === "required";
  }
  if (failed) process.stderr.write("\n(Bypassing with --no-verify only delays this: CI runs the same check.)\n\n");
  return failed ? 1 : 0;
}
var PRE_PUSH_HOOK = (pin) => `#!/bin/sh
# comprende ownership gate (installed by gate.mjs install-hooks)
# pinned-sha256: ${pin}
root="$(git rev-parse --show-toplevel)" || exit 0
gate="$root/${GATE_REL}"
[ -f "$gate" ] || exit 0
command -v node >/dev/null 2>&1 || { echo "ownership gate: node not found, skipping" >&2; exit 0; }
exec env -u NODE_OPTIONS -u NODE_PATH node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const [gate, pin, ...rest] = process.argv.slice(1);
const code = readFileSync(gate);
if (createHash("sha256").update(code).digest("hex") !== pin) {
  process.stderr.write("ownership gate: ${GATE_REL} changed since this hook was installed, so it was not run. If you trust the new version: node ${GATE_REL} install-hooks\\n");
  process.exit(0);
}
process.argv = [process.argv[0], gate, "pre-push", ...rest];
await import("data:text/javascript;base64," + code.toString("base64"));
' "$gate" "${pin}" "$@"
`;
function installHooks(repo, auto = false) {
  const root = repoRoot(repo);
  const gateFile = join7(root, GATE_REL);
  if (isSymlink(gateFile) || !isFile(gateFile))
    return [`SKIPPED pre-push hook: ${GATE_REL} is missing or not a regular file.`];
  const pin = createHash("sha256").update(readFileSync(gateFile)).digest("hex");
  let hooksDir = git(root, ["rev-parse", "--git-path", "hooks"]).trim();
  if (!isAbsolute2(hooksDir)) hooksDir = join7(root, hooksDir);
  const manualLine = `node "$(git rev-parse --show-toplevel)/${GATE_REL}" pre-push "$@" || exit 1`;
  const configured = git(root, ["config", "--get", "core.hooksPath"], { check: false }).trim();
  if (configured) {
    const expanded = configured.replace(/^~(?=$|[/\\])/, homedir2());
    let custom = resolve3(isAbsolute2(expanded) ? expanded : join7(root, expanded));
    try {
      custom = realpathSync2(custom);
    } catch {
    }
    if (auto) {
      return [
        `SKIPPED pre-push hook: core.hooksPath is set (${configured}), so it wasn't added automatically. Run \`node ${GATE_REL} install-hooks\` to add it there.`
      ];
    }
    const rel = relative(realpathSync2(root), custom);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute2(rel)) {
      return [
        `SKIPPED pre-push hook: core.hooksPath (${configured}) is outside this repo and may be shared by other repos. Add this line to its pre-push hook yourself: ${manualLine}`
      ];
    }
    hooksDir = custom;
  }
  const hook = join7(hooksDir, "pre-push");
  if (isSymlink(hook)) return [`SKIPPED pre-push hook: ${hook} is a symlink.`];
  let verb = "installed";
  if (exists(hook)) {
    const text = readFileSync(hook, "utf8");
    if (!text.includes("comprende ownership gate"))
      return [`SKIPPED pre-push hook: ${hook} already exists. Add this line to it: ${manualLine}`];
    if (text.includes(`pinned-sha256: ${pin}`)) return [`pre-push hook already installed (${hook})`];
    verb = "re-pinned";
  }
  mkdirSync2(hooksDir, { recursive: true });
  writeFileSync3(hook, PRE_PUSH_HOOK(pin), "utf8");
  chmodSync2(hook, 493);
  return [`${verb} pre-push hook (${hook}) for gate.mjs sha256 ${pin.slice(0, 12)}`];
}

// src/gate/setup.ts
import { chmodSync as chmodSync3, copyFileSync as copyFileSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname4, join as join8, resolve as resolve4 } from "node:path";
var WORKFLOW = `name: Ownership check

on:
  pull_request:
    # 'edited' re-runs the check when a PR is retargeted to another base branch.
    types: [opened, synchronize, reopened, edited, labeled, unlabeled]

permissions:
  contents: read

jobs:
  ownership:
    name: Ownership check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # Check the PR's own commit (not GitHub's merge commit) with full history,
          # so fingerprints match what the developer verified.
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Verify ownership report
        env:
          BASE_REF: \${{ github.base_ref }}
          HEAD_REF: \${{ github.head_ref }}
          PR_LABELS: \${{ toJSON(github.event.pull_request.labels.*.name) }}
          NODE_OPTIONS: ""
        run: |
          # Run the gate as it exists on the base branch, so a PR can't weaken it
          # by editing ${GATE_REL}. Falls back to the PR's copy only when the base
          # doesn't have the gate yet (the PR that installs it); the rules then
          # are the strict defaults, not the PR's own config.
          if git cat-file -e "origin/$BASE_REF:${GATE_REL}" 2>/dev/null; then
            git show "origin/$BASE_REF:${GATE_REL}" > "$RUNNER_TEMP/gate.mjs"
          else
            cp ${GATE_REL} "$RUNNER_TEMP/gate.mjs"
          fi
          node "$RUNNER_TEMP/gate.mjs" verify --repo . --base "origin/$BASE_REF" \\
            --branch "$HEAD_REF" --labels-json "$PR_LABELS"
`;
var CLAUDE_HOOK_COMMAND = `command -v node >/dev/null 2>&1 || exit 0; exec node "$CLAUDE_PROJECT_DIR/${GATE_REL}" claude-hook`;
var RULESET_NAME = "Ownership gate";
var CHECK_NAME = "Ownership check";
function rulesetBody(approvals = 1, codeOwners = true) {
  return {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: approvals,
          require_code_owner_review: codeOwners,
          dismiss_stale_reviews_on_push: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false
        }
      },
      {
        type: "required_status_checks",
        parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: CHECK_NAME }] }
      }
    ]
  };
}
function gh(root, args, input) {
  let r;
  try {
    r = run("gh", args, { cwd: root, input });
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new GateError(
        "The GitHub CLI (gh) isn't installed. Install it and run `gh auth login`, or set this up by hand: see the README's 'Protect the branch' section."
      );
    }
    throw new GateError(`gh ${args.slice(0, 2).join(" ")} failed: ${e.message}`);
  }
  if (r.status !== 0) {
    const err = (r.stderr.toString("utf8") || r.stdout.toString("utf8")).trim();
    const low = err.toLowerCase();
    if (err.includes("Upgrade to GitHub Pro") || low.includes("upgrade") && low.includes("plan")) {
      throw new GateError(
        "Rulesets aren't available for private repos on GitHub's free plan. Use Settings \u2192 Branches \u2192 branch protection instead (see README)."
      );
    }
    if (err.includes("403") || err.includes("Must have admin rights") || err.includes("Resource not accessible")) {
      throw new GateError("GitHub refused: creating rules needs admin access to this repository.");
    }
    throw new GateError(`gh ${args.slice(0, 2).join(" ")} failed: ${err}`);
  }
  return r.stdout.toString("utf8");
}
function protect(repo, apply = false, approvals = 1, codeOwners = true) {
  const root = repoRoot(repo);
  if (!Number.isInteger(approvals) || approvals < 0 || approvals > 10)
    throw new GateError("--approvals must be between 0 and 10.");
  const nwo = gh(root, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(nwo))
    throw new GateError(`Couldn't tell which GitHub repo this is (got ${JSON.stringify(nwo)}).`);
  let existing = [];
  try {
    existing = JSON.parse(gh(root, ["api", `repos/${nwo}/rulesets`]) || "[]");
  } catch (e) {
    if (e instanceof GateError) throw e;
  }
  for (const r of Array.isArray(existing) ? existing : []) {
    if (isObj(r) && r.name === RULESET_NAME)
      return [`Ruleset '${RULESET_NAME}' already exists on ${nwo}: https://github.com/${nwo}/rules/${String(r.id)}`];
  }
  const body = rulesetBody(approvals, codeOwners);
  const plan = [
    `Ruleset for ${nwo} (default branch): require a pull request with ${approvals} approval(s)` + (codeOwners ? " incl. code owners" : "") + `, and the '${CHECK_NAME}' status check.`,
    "It adds to existing branch protection; it doesn't replace it."
  ];
  if (codeOwners)
    plan.push("Note: a code owner can't approve their own PR. On a one-person repo, use --no-code-owners.");
  if (!apply)
    return [
      ...plan,
      "Dry run \u2014 nothing changed. Rerun with --apply (needs admin) to create it.",
      JSON.stringify(body, null, 2)
    ];
  let created = {};
  try {
    created = JSON.parse(
      gh(root, ["api", "-X", "POST", `repos/${nwo}/rulesets`, "--input", "-"], JSON.stringify(body)) || "{}"
    );
  } catch (e) {
    if (e instanceof GateError) throw e;
  }
  return [...plan, `Created: https://github.com/${nwo}/rules/${String(isObj(created) ? created.id : void 0)}`];
}
function mergeClaudeSettings(path) {
  let settings = {};
  if (lstat(path)) {
    let raw;
    try {
      raw = readSmall(path, MAX_CONFIG_BYTES);
    } catch (e) {
      return `SKIPPED Claude hook: ${e.message}`;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      return `SKIPPED Claude hook: ${path} is not valid JSON; add the hook by hand (see README).`;
    }
    if (!isObj(parsed)) return `SKIPPED Claude hook: ${path} is not a JSON object; add the hook by hand.`;
    settings = parsed;
  }
  if (settings.hooks !== void 0 && !isObj(settings.hooks))
    return `SKIPPED Claude hook: "hooks" in ${path} is not an object; add the hook by hand.`;
  settings.hooks ??= {};
  const hooks = settings.hooks;
  if (hooks.PreToolUse !== void 0 && !Array.isArray(hooks.PreToolUse))
    return `SKIPPED Claude hook: "hooks.PreToolUse" in ${path} is not a list; add the hook by hand.`;
  hooks.PreToolUse ??= [];
  const groups = hooks.PreToolUse;
  for (const g of groups) {
    for (const h of g?.hooks ?? []) {
      if ((h?.command ?? "").includes("gate.mjs") && (h?.command ?? "").includes("claude-hook"))
        return `Claude hook already present (${path})`;
    }
  }
  groups.push({ matcher: "Bash", hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND, timeout: 60 }] });
  atomicWrite(path, `${JSON.stringify(settings, null, 2)}
`);
  return `merged a Claude Code PreToolUse hook into ${path} (other settings kept)`;
}
function ignoreReportInput(root) {
  const path = join8(root, ".gitignore");
  const st = lstat(path);
  if (st && (st.isSymbolicLink() || !st.isFile()))
    return `SKIPPED .gitignore: not a regular file; add ${REPORT_INPUT} to it by hand.`;
  let text = Buffer.alloc(0);
  if (st) {
    try {
      text = Buffer.from(readSmall(path, MAX_CONFIG_BYTES), "utf8");
      if (!text.equals(readFileSync2(path))) throw new GateError("it isn't valid UTF-8");
    } catch (e) {
      return `SKIPPED .gitignore: ${e.message}; add ${REPORT_INPUT} to it by hand.`;
    }
  }
  if (splitLines(text.toString("utf8")).some((l) => [REPORT_INPUT, `/${REPORT_INPUT}`].includes(l.trim()))) {
    return `.gitignore already ignores ${REPORT_INPUT}`;
  }
  atomicWrite(path, withIgnoreLine(text).toString("utf8"));
  return `added ${REPORT_INPUT} to .gitignore`;
}
function codeowners(root, owner) {
  const lines = GATE_FILES.map((p) => `/${p} ${owner || "@your-team-lead"}`);
  if (!owner) {
    return "MANUAL STEP 2: add to .github/CODEOWNERS (or rerun install with --owner @handle) and turn on 'Require review from Code Owners' \u2014 otherwise a PR could edit the workflow to skip the check:\n  " + lines.join("\n  ");
  }
  if (!/^(?:@[\w.-]+(?:\/[\w.-]+)?|[^@\s]+@[^@\s]+)$/.test(owner))
    throw new GateError(`--owner must be a GitHub @user, @org/team, or an email; got ${JSON.stringify(owner)}.`);
  const path = join8(root, ".github", "CODEOWNERS");
  const existing = exists(path) ? readFileSync2(path, "utf8") : "";
  const have = new Set(
    splitLines(existing).filter((l) => l.trim() && !l.trimStart().startsWith("#")).map((l) => l.trim().split(/\s+/)[0])
  );
  const fresh = lines.filter((l) => !have.has(l.split(/\s+/)[0]));
  if (fresh.length) {
    const prefix = !existing || existing.endsWith("\n") ? "" : "\n";
    atomicWrite(
      path,
      `${existing + prefix}# Ownership gate: changes to the gate need lead review
${fresh.join("\n")}
`
    );
  }
  return `CODEOWNERS: ${fresh.length} entries added for ${owner}. MANUAL STEP 2: turn on 'Require review from Code Owners' in branch protection.`;
}
function install(repo, upgrade = false, owner) {
  const root = repoRoot(repo);
  const done = [];
  const target = join8(root, GATE_REL);
  if (!SELF) throw new GateError("Can't locate this gate's own file to install it.");
  if (exists(target) && resolve4(target) === resolve4(SELF)) done.push(`${GATE_REL} is this file`);
  else if (exists(target) && !upgrade) {
    const same = readFileSync2(target).equals(readFileSync2(SELF));
    done.push(`${GATE_REL} ${same ? "up to date" : "exists (pass --upgrade to replace)"}`);
  } else {
    mkdirSync3(dirname4(target), { recursive: true });
    copyFileSync2(SELF, target);
    chmodSync3(target, 493);
    done.push(`wrote ${GATE_REL}`);
  }
  const cfgPath = join8(root, CONFIG_PATH);
  if (exists(cfgPath)) done.push(`${CONFIG_PATH} exists (kept)`);
  else {
    const cfg = { ...DEFAULT_CONFIG };
    try {
      const b = resolveBase(root, { base: "" }, null);
      cfg.base = b.includes("/") ? b.slice(b.indexOf("/") + 1) : b;
    } catch {
      cfg.base = "main";
    }
    atomicWrite(cfgPath, `${JSON.stringify({ ownership_check: cfg }, null, 2)}
`);
    done.push(`wrote ${CONFIG_PATH} (base: ${cfg.base}, mode: required)`);
  }
  const wf = join8(root, ".github", "workflows", "ownership-check.yml");
  const wfRel = ".github/workflows/ownership-check.yml";
  if (exists(wf)) done.push(`${wfRel} exists (kept)`);
  else {
    atomicWrite(wf, WORKFLOW);
    done.push(`wrote ${wfRel}`);
  }
  done.push(mergeClaudeSettings(join8(root, ".claude", "settings.json")));
  done.push(ignoreReportInput(root));
  done.push(...installHooks(root));
  done.push(
    `NEXT, after this is merged: run \`node ${GATE_REL} protect\` (dry run, then --apply) to require the '${CHECK_NAME}' status on the default branch \u2014 without it CI only warns.`
  );
  done.push(codeowners(root, owner));
  return done;
}

// src/gate/cli.ts
var HELP = `Ownership gate (comprende)

Commands (run from inside the repo, or pass --repo):
  status         Which changed files are new / stale / ok vs. the report   [--json]
  save           Write the report from JSON {"summary", "verified": {path: [concepts]}} on stdin,
                 or --input .learning/report.local.json (deleted after a successful save)
  verify         Check a commit (default HEAD) against its report \u2014 used by CI   [--json]
  pre-push       Git pre-push hook entry point (reads refs from stdin)
  claude-hook    Claude Code PreToolUse hook entry point (reads JSON from stdin)
  session-start  Claude Code SessionStart hook (plugin): the always-on note; in gated repos, the git hook
  install        Add the gate, config, CI workflow, Claude hook and git hook to a repo
  install-hooks  Install only the local git pre-push hook (once per clone)
  protect        Create the GitHub ruleset that makes the check required (gh; dry run by default)
  version        Print the gate version

Common options: --repo PATH  --base REF  --branch NAME
`;
function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  for (; ; ) {
    let n;
    try {
      n = readSync2(0, buf, 0, buf.length, null);
    } catch (e) {
      const code = e.code;
      if (code === "EAGAIN") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      if (code === "EOF" || code === "ENOTCONN" || code === "EINVAL" || code === "EBADF") break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
var FLAGS = /* @__PURE__ */ new Set(["json", "from-plugin", "upgrade", "apply", "no-code-owners", "help"]);
var VALUE_OPTS = /* @__PURE__ */ new Set(["repo", "base", "branch", "input", "rev", "labels-json", "owner", "approvals"]);
function parseArgs(argv) {
  const [cmd = "", ...tail] = argv;
  const opts = {};
  const rest = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (FLAGS.has(k) && v === void 0) opts[k] = true;
      else if (VALUE_OPTS.has(k)) {
        const val = v ?? tail[++i];
        if (val === void 0 || v === void 0 && val.startsWith("--"))
          throw new UsageError(`--${k} needs a value`);
        opts[k] = val;
      } else if (cmd === "pre-push") rest.push(a);
      else throw new UsageError(`unknown option --${k}`);
    } else rest.push(a);
  }
  if (rest.length && !["pre-push", "__test"].includes(cmd)) throw new UsageError(`unexpected argument ${rest[0]}`);
  return { cmd, opts, rest };
}
var UsageError = class extends Error {
};
function testCall(fn, a) {
  const s = (i) => a[i] === null || a[i] === void 0 ? null : String(a[i]);
  const consts = {
    GATE_VERSION,
    GATE_FILES,
    WORKFLOW,
    CHECK_NAME,
    REPO_GATE: GATE_REL,
    ALWAYS_ON
  };
  if (fn in consts) return consts[fn];
  switch (fn) {
    case "collect_changes": {
      const [c, u, mb] = collectChanges(repoRoot(s(0)), String(a[1]), s(2));
      return [c, sorted(u), mb];
    }
    case "read_report":
      return readReport(repoRoot(s(0)), String(a[1]), s(2));
    case "merge_claude_settings":
      return mergeClaudeSettings(String(a[0]));
    case "is_push_command":
      return isPushCommand(String(a[0]));
    case "is_plumbing":
      return isPlumbing(String(a[0]), a[1] === void 0 ? void 0 : String(a[1]));
    case "is_sensitive":
      return isSensitive(String(a[0]), String(a[1]), a[2]);
    case "md_safe":
      return mdSafe(String(a[0]));
    case "report_relpath":
      return reportRelpath(String(a[0]));
    case "render_report":
      return renderReport(a[0]);
    case "parse_report":
      return parseReport(String(a[0]));
    default:
      throw new GateError(`unknown test function ${fn}`);
  }
}
function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}

${HELP}`);
    return 2;
  }
  const { cmd, opts, rest } = args;
  const o = (k) => typeof opts[k] === "string" ? opts[k] : null;
  const out = (s) => process.stdout.write(`${s}
`);
  try {
    switch (cmd) {
      case "":
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(HELP);
        return cmd ? 0 : 2;
      case "version":
        out(String(GATE_VERSION));
        return 0;
      case "status": {
        const st = status(o("repo"), o("base"), o("branch"));
        out(opts.json ? JSON.stringify(st, null, 2) : formatStatus(st));
        return 0;
      }
      case "save": {
        const raw = o("input") ? readFileSync3(o("input"), "utf8") : readStdin();
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          throw new GateError(`Input is not valid JSON: ${e.message}`);
        }
        if (!isObj(payload)) throw new GateError('Input must be a JSON object with "summary" and "verified".');
        const saved = save(payload, o("repo"), o("base"), o("branch"));
        out(o("input") ? saved + removeReportInput(o("input"), o("repo")) : saved);
        return 0;
      }
      case "verify": {
        let labels = [];
        const lj = o("labels-json");
        if (lj?.trim()) {
          try {
            const parsed = JSON.parse(lj);
            if (!Array.isArray(parsed)) throw new Error("not a list");
            labels = parsed.map(String);
          } catch {
            throw new GateError("--labels-json must be a JSON list of label names.");
          }
        }
        const rev = o("rev") ?? "HEAD";
        const [passed, messages, mode] = verify(o("repo"), o("base"), o("branch"), rev, labels);
        if (opts.json) {
          out(JSON.stringify({ passed, messages, mode }));
          return 0;
        }
        const summaryPath = process.env.GITHUB_STEP_SUMMARY;
        if (summaryPath) {
          try {
            const root = repoRoot(o("repo"));
            appendFileSync(
              summaryPath,
              jobSummary(root, currentBranch(root, o("branch")), rev, o("base"), passed, messages, mode),
              "utf8"
            );
          } catch {
          }
        }
        if (passed) {
          if (messages.length) ci(mode === "skipped" ? "warning" : "notice", messages);
          out(messages.length ? messages[0] : mode === "off" ? "Ownership check is off." : "Ownership check passed.");
          return 0;
        }
        ci(mode === "required" ? "error" : "warning", messages);
        process.stderr.write(`Ownership check failed:
- ${messages.join("\n- ")}
`);
        return mode === "required" ? 1 : 0;
      }
      case "pre-push":
        return prePush(readStdin(), o("repo"));
      case "claude-hook":
        return claudeHook(readStdin(), Boolean(opts["from-plugin"]));
      case "session-start":
        out(JSON.stringify(sessionStart(readStdin())));
        return 0;
      case "install":
      case "install-hooks":
      case "protect": {
        let lines;
        if (cmd === "install") lines = install(o("repo"), Boolean(opts.upgrade), o("owner"));
        else if (cmd === "install-hooks") lines = installHooks(o("repo"));
        else {
          const n = o("approvals");
          if (n !== null && !/^\d+$/.test(n)) throw new GateError("--approvals must be between 0 and 10.");
          const approvals = n === null ? 1 : Number(n);
          lines = protect(o("repo"), Boolean(opts.apply), approvals, !opts["no-code-owners"]);
        }
        out(opts.json ? JSON.stringify(lines) : lines.join("\n"));
        return 0;
      }
      case "__test": {
        const [fn, json = "[]"] = rest;
        out(JSON.stringify(testCall(fn, JSON.parse(json))));
        return 0;
      }
      default:
        process.stderr.write(`unknown command ${cmd}

${HELP}`);
        return 2;
    }
  } catch (e) {
    const msg = e.message;
    if (!(e instanceof GateError)) {
      const code = e.code;
      if (!code) throw e;
    }
    process.stderr.write(`ownership gate: ${msg}
`);
    ci("error", [msg]);
    return 1;
  }
}
process.exitCode = main(process.argv.slice(2));
export {
  main
};
