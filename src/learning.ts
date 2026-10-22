// Manage a project's .learning/ folder for the Comprende skill (usage below).
// Bundled into a single file that needs only Node's built-ins.
import * as fs from "node:fs";
import { exists, isDir, joinPath, pyIntDigits, pySplitlines, readTextStrict, realpath, today } from "./store.js";

const USAGE = `Manage a project's .learning/ folder for the comprende skill.

Usage:
  learning.mjs init <repo-root>
      Create .learning/ with templates and git-ignore the personal file.
      Safe to run again: existing files are never overwritten.

  learning.mjs decision <repo-root> "<title>"
      Create the next numbered decision record and print its path.

Node built-ins only, so it runs anywhere Node 20+ exists.
`;

const GITIGNORE_LINE = ".learning/*.local.md";
const TODAY = today();

const MAP_TEMPLATE = `# Project map
Verified: ${TODAY}

Entry points:
Core modules:
Data flow:
Gotchas:
`;

const ME_TEMPLATE = `# What I know (personal — not committed)
Updated: ${TODAY}

## Comfortable

## Learning

## Already explained

## Preferences
`;

const decisionTemplate = (num: number, title: string, date: string) => `# ${String(num).padStart(4, "0")} — ${title}
Date: ${date} · Status: accepted

Context:
Decision:
Alternatives:
-
Consequences:
`;

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** `sys.exit(message)`: message to stderr, exit status 1. */
function exit(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function writeIfMissing(path: string, content: string, created: string[]): void {
  // Never overwrite: these files hold the user's accumulated notes.
  if (!exists(path)) {
    fs.writeFileSync(path, content, "utf8");
    created.push(path);
  }
}

function ensureGitignored(root: string, created: string[]): void {
  const gitignore = joinPath(root, ".gitignore");
  const existing = exists(gitignore) ? readTextStrict(gitignore) : "";
  if (pySplitlines(existing).includes(GITIGNORE_LINE)) return;
  // Keep the file's last line intact if it lacks a trailing newline.
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(gitignore, `${prefix}${GITIGNORE_LINE}\n`, "utf8");
  created.push(`${gitignore} (added ${GITIGNORE_LINE})`);
}

function init(root: string): void {
  const base = joinPath(root, ".learning");
  fs.mkdirSync(joinPath(base, "decisions"), { recursive: true });
  const created: string[] = [];
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

function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/g, "");
  return Array.from(slug).slice(0, 60).join("") || "decision";
}

const NUMBERED = /^(\p{Nd}{4})-/u;

function decision(root: string, title: string): void {
  const folder = joinPath(joinPath(root, ".learning"), "decisions");
  if (!isDir(folder)) exit("No .learning/decisions/ here. Run `learning.mjs init` first.");
  // Next number = highest existing + 1, so deleted records never cause reuse.
  const numbers = fs
    .readdirSync(folder)
    .filter((name) => name.endsWith(".md"))
    .map((name) => NUMBERED.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => pyIntDigits(m[1]!));
  const num = Math.max(0, ...numbers) + 1;
  const path = joinPath(folder, `${String(num).padStart(4, "0")}-${slugify(title)}.md`);
  fs.writeFileSync(path, decisionTemplate(num, title, TODAY), "utf8");
  print(path);
}

function main(argv: string[]): void {
  if (argv.length >= 2 && argv[0] === "init") init(realpath(argv[1]!));
  else if (argv.length >= 3 && argv[0] === "decision") decision(realpath(argv[1]!), argv.slice(2).join(" "));
  else exit(USAGE);
}

main(process.argv.slice(2));
