#!/usr/bin/env node
// Generated from src/learning.ts by build.mjs. Edit the source, then run `npm run build`.


// src/learning.ts
import * as fs2 from "node:fs";
import { join as join2 } from "node:path";

// src/store/common.ts
import * as fs from "node:fs";
import * as os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
var SLUG_MAX_CHARS = 60;
var truncate = (s, n) => s.length <= n ? s : Array.from(s).slice(0, n).join("");
function slug(text) {
  const s = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return truncate(s, SLUG_MAX_CHARS);
}
var expandHome = (p) => p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p;
function resolveUserPath(p) {
  const abs = resolve(expandHome(p));
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}
var START = "(?<![\\p{L}\\p{N}_])";
var END = "(?![\\p{L}\\p{N}_])";
var SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  new RegExp(`${START}AKIA[0-9A-Z]{16}${END}`, "u"),
  // AWS access key
  new RegExp(`${START}(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}`, "u"),
  // API keys
  new RegExp(`${START}gh[pousr]_[A-Za-z0-9]{30,}${END}`, "u"),
  // GitHub tokens
  new RegExp(`${START}xox[abprs]-[A-Za-z0-9-]{10,}`, "u"),
  // Slack tokens
  new RegExp(`${START}(password|passwd|secret|api[_-]?key|token)\\s*[:=]\\s*\\S{6,}`, "iu"),
  new RegExp(`${START}[a-z]+://[^/\\s:]+:[^@\\s]+@`, "iu")
  // user:pass@host URLs
];

// src/util.ts
function today() {
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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
  if (!fs2.existsSync(path)) {
    fs2.writeFileSync(path, content, "utf8");
    created.push(path);
  }
}
function ensureGitignored(root, created) {
  const gitignore = join2(root, ".gitignore");
  const existing = fs2.existsSync(gitignore) ? fs2.readFileSync(gitignore, "utf8") : "";
  if (existing.split(/\r\n|\r|\n/).includes(GITIGNORE_LINE)) return;
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs2.appendFileSync(gitignore, `${prefix}${GITIGNORE_LINE}
`, "utf8");
  created.push(`${gitignore} (added ${GITIGNORE_LINE})`);
}
function init(root) {
  const base = join2(root, ".learning");
  fs2.mkdirSync(join2(base, "decisions"), { recursive: true });
  const created = [];
  writeIfMissing(join2(base, "map.md"), MAP_TEMPLATE, created);
  writeIfMissing(join2(base, "me.local.md"), ME_TEMPLATE, created);
  ensureGitignored(root, created);
  if (created.length) {
    print("Created:");
    for (const item of created) print(`  ${item}`);
  } else {
    print(`${base} already set up; nothing changed.`);
  }
}
var NUMBERED = /^([0-9]{4})-/;
function decision(root, title) {
  const folder = join2(root, ".learning", "decisions");
  if (!fs2.statSync(folder, { throwIfNoEntry: false })?.isDirectory())
    exit("No .learning/decisions/ here. Run `learning.mjs init` first.");
  const numbers = fs2.readdirSync(folder).filter((name) => name.endsWith(".md")).map((name) => NUMBERED.exec(name)).filter((m) => m !== null).map((m) => Number.parseInt(m[1], 10));
  const num = Math.max(0, ...numbers) + 1;
  const path = join2(folder, `${String(num).padStart(4, "0")}-${slug(title) || "decision"}.md`);
  fs2.writeFileSync(path, decisionTemplate(num, title, TODAY), "utf8");
  print(path);
}
function main(argv) {
  if (argv.length >= 2 && argv[0] === "init") init(resolveUserPath(argv[1]));
  else if (argv.length >= 3 && argv[0] === "decision") decision(resolveUserPath(argv[1]), argv.slice(2).join(" "));
  else exit(USAGE);
}
main(process.argv.slice(2));
