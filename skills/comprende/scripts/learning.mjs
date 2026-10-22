#!/usr/bin/env node
// Generated from src/learning.ts by build.mjs. Edit the source, then run `npm run build`.


// src/learning.ts
import * as fs2 from "node:fs";

// src/store.ts
import * as fs from "node:fs";
var WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
var WORD = "\\p{L}\\p{N}_";
var NOT_WORD_BEFORE = `(?<![${WORD}])`;
var NOT_WORD_AFTER = `(?![${WORD}])`;
var STRIP_RE = new RegExp(`^[${WS}]+|[${WS}]+$`, "gu");
var SPLIT_RE = new RegExp(`[${WS}]+`, "u");
var LINE_BREAKS = /* @__PURE__ */ new Set(["\n", "\r", "\v", "\f", "", "", "", "\x85", "\u2028", "\u2029"]);
function pyTypeName(v) {
  if (v === null || v === void 0) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "bigint") return "int";
  if (typeof v === "number") return "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  return "dict";
}
function needStr(v, method) {
  if (typeof v !== "string") throw new TypeError(`'${pyTypeName(v)}' object has no attribute '${method}'`);
  return v;
}
function pySplitlines(s) {
  const text = needStr(s, "splitlines");
  const out = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (LINE_BREAKS.has(c)) {
      out.push(text.slice(start, i));
      if (c === "\r" && text[i + 1] === "\n") i++;
      start = ++i;
    } else {
      i++;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}
var ND = new RegExp("^\\p{Nd}$", "u");
function digitValue(cp) {
  let start = cp;
  while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}
function pyIntDigits(s) {
  let n = 0;
  for (const ch of s) n = n * 10 + digitValue(ch.codePointAt(0));
  return n;
}
var PY_INT_RE = new RegExp(`^[${WS}]*([+-]?)(\\p{Nd}+(?:_\\p{Nd}+)*)[${WS}]*$`, "u");
var STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
var LENIENT_UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });
function universalNewlines(s) {
  return s.replace(/\r\n?/g, "\n");
}
function readTextStrict(path) {
  const buf = fs.readFileSync(path);
  let text;
  try {
    text = STRICT_UTF8.decode(buf);
  } catch {
    throw new Error(`'utf-8' codec can't decode bytes in ${path}: invalid UTF-8`);
  }
  return universalNewlines(text);
}
function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function joinPath(a, b) {
  return a.endsWith("/") ? a + b : `${a}/${b}`;
}
function realpath(p) {
  const rest = p.split("/").reverse();
  let partCount = rest.length;
  let path = p.startsWith("/") ? "/" : process.cwd();
  const seen = /* @__PURE__ */ new Map();
  while (partCount) {
    const name = rest.pop();
    if (name === null) {
      seen.set(rest.pop(), path);
      continue;
    }
    partCount--;
    if (!name || name === ".") continue;
    if (name === "..") {
      path = path.slice(0, path.lastIndexOf("/")) || "/";
      continue;
    }
    const newpath = path === "/" ? path + name : `${path}/${name}`;
    let target;
    try {
      if (!fs.lstatSync(newpath).isSymbolicLink()) {
        path = newpath;
        continue;
      }
      if (seen.has(newpath)) {
        const cached = seen.get(newpath);
        path = cached ?? newpath;
        continue;
      }
      target = fs.readlinkSync(newpath);
    } catch {
      path = newpath;
      continue;
    }
    if (target.startsWith("/")) path = "/";
    seen.set(newpath, null);
    rest.push(newpath, null);
    const targetParts = target.split("/").reverse();
    rest.push(...targetParts);
    partCount += targetParts.length;
  }
  return path;
}
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function today() {
  return isoDate(/* @__PURE__ */ new Date());
}
function ci(word) {
  const extra = { i: "\u0130\u0131", s: "\u017F", k: "\u212A" };
  return [...word].map((c) => /[a-z]/.test(c) ? `[${c}${c.toUpperCase()}${extra[c] ?? ""}]` : c).join("");
}
var SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  new RegExp(`${NOT_WORD_BEFORE}AKIA[0-9A-Z]{16}${NOT_WORD_AFTER}`, "u"),
  // AWS access key
  new RegExp(`${NOT_WORD_BEFORE}(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}`, "u"),
  new RegExp(`${NOT_WORD_BEFORE}gh[pousr]_[A-Za-z0-9]{30,}${NOT_WORD_AFTER}`, "u"),
  // GitHub tokens
  new RegExp(`${NOT_WORD_BEFORE}xox[abprs]-[A-Za-z0-9-]{10,}`, "u"),
  // Slack tokens
  new RegExp(
    `${NOT_WORD_BEFORE}(${ci("password")}|${ci("passwd")}|${ci("secret")}|${ci("api")}[_-]?${ci("key")}|${ci("token")})[${WS}]*[:=][${WS}]*[^${WS}]{6,}`,
    "u"
  ),
  new RegExp(`${NOT_WORD_BEFORE}[a-zA-Z\u0130\u0131\u017F\u212A]+://[^/${WS}:]+:[^@${WS}]+@`, "u")
  // user:pass@host URLs
];
var DECISION_NAME = new RegExp("^\\p{Nd}{4}-", "u");

// src/learning.ts
var USAGE = `Manage a project's .learning/ folder for the comprende skill.

Usage:
  learning.mjs init <repo-root>
      Create .learning/ with templates and git-ignore the personal file.
      Safe to run again: existing files are never overwritten.

  learning.mjs decision <repo-root> "<title>"
      Create the next numbered decision record and print its path.

Node built-ins only, so it runs anywhere Node 20+ exists.
`;
var GITIGNORE_LINE = ".learning/*.local.md";
var TODAY = today();
var MAP_TEMPLATE = `# Project map
Verified: ${TODAY}

Entry points:
Core modules:
Data flow:
Gotchas:
`;
var ME_TEMPLATE = `# What I know (personal \u2014 not committed)
Updated: ${TODAY}

## Comfortable

## Learning

## Already explained

## Preferences
`;
var decisionTemplate = (num, title, date) => `# ${String(num).padStart(4, "0")} \u2014 ${title}
Date: ${date} \xB7 Status: accepted

Context:
Decision:
Alternatives:
-
Consequences:
`;
function print(line) {
  process.stdout.write(`${line}
`);
}
function exit(message) {
  process.stderr.write(`${message}
`);
  process.exit(1);
}
function writeIfMissing(path, content, created) {
  if (!exists(path)) {
    fs2.writeFileSync(path, content, "utf8");
    created.push(path);
  }
}
function ensureGitignored(root, created) {
  const gitignore = joinPath(root, ".gitignore");
  const existing = exists(gitignore) ? readTextStrict(gitignore) : "";
  if (pySplitlines(existing).includes(GITIGNORE_LINE)) return;
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs2.appendFileSync(gitignore, `${prefix}${GITIGNORE_LINE}
`, "utf8");
  created.push(`${gitignore} (added ${GITIGNORE_LINE})`);
}
function init(root) {
  const base = joinPath(root, ".learning");
  fs2.mkdirSync(joinPath(base, "decisions"), { recursive: true });
  const created = [];
  writeIfMissing(joinPath(base, "map.md"), MAP_TEMPLATE, created);
  writeIfMissing(joinPath(base, "me.local.md"), ME_TEMPLATE, created);
  ensureGitignored(root, created);
  if (created.length) {
    print("Created:");
    for (const item of created) print(`  ${item}`);
  } else {
    print(`${base} already set up; nothing changed.`);
  }
}
function slugify(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/g, "");
  return Array.from(slug).slice(0, 60).join("") || "decision";
}
var NUMBERED = new RegExp("^(\\p{Nd}{4})-", "u");
function decision(root, title) {
  const folder = joinPath(joinPath(root, ".learning"), "decisions");
  if (!isDir(folder)) exit("No .learning/decisions/ here. Run `learning.mjs init` first.");
  const numbers = fs2.readdirSync(folder).filter((name) => name.endsWith(".md")).map((name) => NUMBERED.exec(name)).filter((m) => m !== null).map((m) => pyIntDigits(m[1]));
  const num = Math.max(0, ...numbers) + 1;
  const path = joinPath(folder, `${String(num).padStart(4, "0")}-${slugify(title)}.md`);
  fs2.writeFileSync(path, decisionTemplate(num, title, TODAY), "utf8");
  print(path);
}
function main(argv) {
  if (argv.length >= 2 && argv[0] === "init") init(realpath(argv[1]));
  else if (argv.length >= 3 && argv[0] === "decision") decision(realpath(argv[1]), argv.slice(2).join(" "));
  else exit(USAGE);
}
main(process.argv.slice(2));
