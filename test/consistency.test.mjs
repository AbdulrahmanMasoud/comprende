// The plugin's files agree with each other: manifests, built copies, docs and the demo.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ENV, git, NODE, REPO, SUMMARY, setup, sh, tmp } from "./helpers.mjs";

const read = (rel) => readFileSync(join(REPO, rel));

const json = (rel) => JSON.parse(read(rel).toString("utf8"));

/** The commands the tape types, in order (each `Type` line up to its `Enter`). */
function tapeCommands(tape) {
  const out = [];
  let current = "";
  for (const line of tape.split("\n")) {
    const typed = /^Type\s+(?:"(.*)"|`(.*)`)\s*$/.exec(line);
    if (typed) current += typed[1] ?? typed[2];
    else if (/^Enter\b/.test(line)) {
      out.push(current);
      current = "";
    }
  }
  return out;
}

test("the skill's scripts are exact copies of the built files", () => {
  for (const name of ["gate.mjs", "learning.mjs"]) {
    assert.ok(
      read(`dist/${name}`).equals(read(`skills/comprende/scripts/${name}`)),
      `${name} differs; run npm run build`,
    );
  }
});

test("manifests, hooks and the MCP config point at real files", () => {
  const plugin = json(".claude-plugin/plugin.json");
  const market = json(".claude-plugin/marketplace.json");
  assert.equal(market.plugins[0].name, plugin.name);
  assert.ok(!("version" in market.plugins[0]), "set the version in plugin.json only");
  assert.ok(plugin.version);
  const hooks = json("hooks/hooks.json").hooks;
  const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
  for (const c of commands) {
    // The only thing a hook ever runs with node is the plugin's own gate.
    const targets = [...c.matchAll(/\bnode\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(targets.length > 0, c);
    for (const target of targets) assert.equal(target, "${CLAUDE_PLUGIN_ROOT}/dist/gate.mjs");
    assert.ok(existsSync(join(REPO, "dist/gate.mjs")));
  }
  assert.ok(commands.some((c) => /gate\.mjs" session-start\b/.test(c)));
  assert.ok(commands.some((c) => c.endsWith(" claude-hook --from-plugin")));
  const mcp = json(".mcp.json").mcpServers["comprende"];
  assert.equal(mcp.command, "node");
  assert.deepEqual(mcp.args, ["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs"]);
  assert.ok(existsSync(join(REPO, "dist/server.mjs")));
});

test("the gate imports nothing but node: built-ins", () => {
  const code = read("dist/gate.mjs").toString("utf8");
  const specs = [...code.matchAll(/^\s*import\b[^"'\n]*["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.ok(s.startsWith("node:"), `unexpected import ${s}`);
  assert.match(code, /^\/\/ ownership-gate-version: \d+$/m);
});

/** The first `## ` section of a Markdown file. */
function firstSection(md) {
  const start = md.indexOf("\n## ");
  const end = md.indexOf("\n## ", start + 1);
  return md.slice(start, end < 0 ? undefined : end);
}

/** The bodies of a Markdown file's ```bash blocks, in order. */
const bashBlocks = (md) => [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);

/** GitHub's anchor for a Markdown heading. */
const anchor = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

const headingAnchors = (rel) =>
  read(rel)
    .toString("utf8")
    .split("\n")
    .filter((l) => /^#{1,6} /.test(l))
    .map((l) => anchor(l.replace(/^#+ /, "")));

test("both READMEs open with the install commands, then cover both parts", () => {
  const en = read("README.md").toString("utf8");
  const ar = read("README.ar.md").toString("utf8");
  for (const md of [en, ar]) {
    const install = firstSection(md);
    // The terminal commands install for the user, so the plugin is on in every project.
    assert.ok(install.includes("claude plugin marketplace add AbdulrahmanMasoud/comprende"));
    assert.ok(install.includes("claude plugin install comprende@comprende"));
    assert.ok(install.includes("`/mcp`"), "how to check that the install worked");
    assert.ok(md.includes("](docs/demo.gif)"), "the demo GIF is embedded");
    assert.ok(md.includes("node .learning/gate.mjs protect --apply"));
  }
  assert.ok(en.includes("Enable the ownership gate in this repo") && en.includes('"check me"'));
  assert.deepEqual(bashBlocks(ar), bashBlocks(en), "both READMEs give the same commands");
  assert.ok(existsSync(join(REPO, "docs/demo.gif")));
  assert.ok(read("CONTRIBUTING.md").toString("utf8").includes("docs/demo.tape"), "the demo's source is documented");
});

test("the README's 'try it' script makes a gated repo where an unchecked push is blocked", (t) => {
  const en = read("README.md").toString("utf8");
  const [script] = bashBlocks(en.slice(en.indexOf("\n## Try it in 5 minutes\n")));
  // The test can't use /tmp, the network or Claude, so it swaps those three
  // lines and runs the rest exactly as written.
  const swaps = new Map([
    ["mkdir -p /tmp/comprende-try && cd /tmp/comprende-try", 'cd "$TRY"'],
    ["git clone -q https://github.com/AbdulrahmanMasoud/comprende.git", 'ln -s "$COMPRENDE" comprende'],
    ["claude", ""],
  ]);
  const lines = script.trim().split("\n");
  for (const line of swaps.keys()) assert.ok(lines.includes(line), `the script no longer has: ${line}`);
  const body = lines.map((l) => swaps.get(l) ?? l).join("\n");
  const dir = tmp(t);
  const env = { ...ENV, HOME: dir, TMPDIR: dir, TRY: dir, COMPRENDE: REPO };
  sh(dir, "bash", ["--noprofile", "--norc", "-ec", body], { env });
  const app = join(dir, "app");
  assert.equal(git(app, "branch", "--show-current").stdout.trim(), "feature/sum");
  git(app, "cat-file", "-e", "origin/main:.learning/gate.mjs");
  // What the reader does next, without Claude: change the code and push it.
  writeFileSync(
    join(app, "math.js"),
    "export const add = (a, b) => a + b;\nexport const sum = (xs) => xs.reduce(add, 0);\n",
  );
  git(app, "commit", "-qam", "add sum");
  const push = sh(app, "git", ["push", "-u", "origin", "feature/sum"], { check: false, env });
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /Ownership gate blocked/);
});

test("relative links in the docs point at files that exist", () => {
  const docs = ["README.md", "README.ar.md", "CONTRIBUTING.md", "SECURITY.md", "docs/teams.md", "docs/how-it-works.md"];
  for (const rel of docs) {
    for (const [, target] of read(rel)
      .toString("utf8")
      .matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const [file, hash] = target.split("#");
      const path = join(REPO, rel, "..", file);
      if (!path.startsWith(REPO)) continue; // a GitHub page, like ../../security/advisories/new
      assert.ok(existsSync(path), `${rel} links to ${target}`);
      if (hash) assert.ok(headingAnchors(join(rel, "..", file)).includes(hash), `${rel} links to ${target}`);
    }
  }
});

test("the gate's 'do it by hand' messages link to a docs section that exists", () => {
  const code = read("dist/gate.mjs").toString("utf8");
  assert.doesNotMatch(code, /see (the )?README/, "link a section of docs/ instead");
  const links = [
    ...code.matchAll(/https:\/\/github\.com\/AbdulrahmanMasoud\/comprende\/blob\/main\/([\w./-]+)#([\w-]+)/g),
  ];
  assert.ok(links.length >= 2);
  for (const [url, file, hash] of links) assert.ok(headingAnchors(file).includes(hash), url);
});

test("docs/demo.tape runs: the push is blocked, a report is saved, the push goes through", (t) => {
  const tape = read("docs/demo.tape").toString("utf8");
  assert.match(tape, /^Output docs\/demo\.gif$/m);
  const commands = tapeCommands(tape);
  assert.ok(commands.length >= 6, `only ${commands.length} commands`);
  // Run exactly what VHS would type, from the repo root, in bash, with one
  // output stream as on screen.
  const home = tmp(t);
  const script = ["exec 2>&1", ...commands].join("\n");
  const r = sh(REPO, "bash", ["--noprofile", "--norc", "-c", script], {
    check: false,
    env: { ...ENV, HOME: home, TMPDIR: home },
  });
  const out = r.stdout;
  assert.equal(r.status, 0, out);
  const blocked = out.indexOf("Ownership gate blocked");
  const saved = out.indexOf("Saved .learning/checks/");
  const pushed = out.indexOf("feature/sum -> feature/sum");
  assert.ok(blocked >= 0 && saved > blocked && pushed > saved, out);
});

test("the Claude hook in docs/teams.md is the one install writes", (t) => {
  const { dev } = setup(t);
  const settings = JSON.parse(readFileSync(join(dev, ".claude/settings.json"), "utf8"));
  const { command } = settings.hooks.PreToolUse[0].hooks[0];
  assert.match(command, /claude-hook$/);
  assert.ok(read("docs/teams.md").toString("utf8").includes(JSON.stringify(command)), "update the snippet");
});

// Sanity: SUMMARY and NODE are what the other suites use.
test("the shared test fixtures are usable", () => {
  assert.ok(SUMMARY.length >= 80);
  assert.ok(NODE);
});
