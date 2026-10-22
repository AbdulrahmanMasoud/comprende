// Manage a project's .learning/ folder for the Comprende skill (usage below).
// Bundled into a single file that needs only Node's built-ins.
import * as fs from "node:fs";
import { join } from "node:path";
import { resolveUserPath, slug } from "./store/common.js";
import { today } from "./util.js";

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

/** Print `message` to stderr and exit with status 1. */
function exit(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function writeIfMissing(path: string, content: string, created: string[]): void {
  // Never overwrite: these files hold the user's accumulated notes.
  if (!fs.existsSync(path)) {
    fs.writeFileSync(path, content, "utf8");
    created.push(path);
  }
}

function ensureGitignored(root: string, created: string[]): void {
  const gitignore = join(root, ".gitignore");
  const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
  if (existing.split(/\r\n|\r|\n/).includes(GITIGNORE_LINE)) return;
  // Keep the file's last line intact if it lacks a trailing newline.
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(gitignore, `${prefix}${GITIGNORE_LINE}\n`, "utf8");
  created.push(`${gitignore} (added ${GITIGNORE_LINE})`);
}

function init(root: string): void {
  const base = join(root, ".learning");
  fs.mkdirSync(join(base, "decisions"), { recursive: true });
  const created: string[] = [];
  writeIfMissing(join(base, "map.md"), MAP_TEMPLATE, created);
  writeIfMissing(join(base, "me.local.md"), ME_TEMPLATE, created);
  ensureGitignored(root, created);
  if (created.length) {
    print("Created:");
    for (const item of created) print(`  ${item}`);
  } else {
    print(`${base} already set up; nothing changed.`);
  }
}

const NUMBERED = /^([0-9]{4})-/;

function decision(root: string, title: string): void {
  const folder = join(root, ".learning", "decisions");
  if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory())
    exit("No .learning/decisions/ here. Run `learning.mjs init` first.");
  // Next number = highest existing + 1, so deleted records never cause reuse.
  const numbers = fs
    .readdirSync(folder)
    .filter((name) => name.endsWith(".md"))
    .map((name) => NUMBERED.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number.parseInt(m[1]!, 10));
  const num = Math.max(0, ...numbers) + 1;
  const path = join(folder, `${String(num).padStart(4, "0")}-${slug(title) || "decision"}.md`);
  fs.writeFileSync(path, decisionTemplate(num, title, TODAY), "utf8");
  print(path);
}

function main(argv: string[]): void {
  if (argv.length >= 2 && argv[0] === "init") init(resolveUserPath(argv[1]!));
  else if (argv.length >= 3 && argv[0] === "decision") decision(resolveUserPath(argv[1]!), argv.slice(2).join(" "));
  else exit(USAGE);
}

main(process.argv.slice(2));
