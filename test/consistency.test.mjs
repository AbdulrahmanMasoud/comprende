// The plugin's files agree with each other: manifests, built copies, docs and the demo.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { commitAll, ENV, GATE, gate, git, NODE, REPO, SUMMARY, setup, sh, tmp, write } from "./helpers.mjs";

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

test("the version files agree with the newest CHANGELOG entry", () => {
  const r = sh(REPO, NODE, [join(REPO, "tools/release.mjs"), "check"], { check: false });
  assert.equal(r.status, 0, r.stderr);
});

/** The oldest Node major that package.json's engines.node allows, from ">=N". */
function oldestSupportedNode() {
  const { engines } = json("package.json");
  const oldest = /^>=(\d+)$/.exec(engines.node)?.[1];
  assert.ok(oldest, `engines.node should be '>=N', not '${engines.node}'`);
  return Number(oldest);
}

test("@types/node is for the oldest Node in engines.node, so typecheck rejects newer APIs", () => {
  const types = json("package.json").devDependencies["@types/node"];
  const major = /^\^?(\d+)\.\d+\.\d+$/.exec(types)?.[1];
  assert.ok(major, `@types/node should be 'N.x.y' or '^N.x.y', not '${types}'`);
  assert.equal(Number(major), oldestSupportedNode(), `@types/node is ${types}`);
});

test("CI's oldest Node is the oldest in engines.node", () => {
  const nodes = parseYaml(read(".github/workflows/ci.yml").toString("utf8")).jobs.test.strategy.matrix.node;
  assert.equal(Math.min(...nodes), oldestSupportedNode(), `ci.yml tests Node ${nodes.join(", ")}`);
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
  const videos = (md) => [...md.matchAll(/https:\/\/youtu\.be\/[\w-]+/g)].map((m) => m[0]);
  assert.ok(videos(en).length > 0);
  assert.deepEqual(videos(ar), videos(en), "both READMEs link the same video");
  assert.ok(existsSync(join(REPO, "docs/demo.gif")));
  assert.ok(read("CONTRIBUTING.md").toString("utf8").includes("docs/demo.tape"), "the demo's source is documented");
});

test("the README's 'try it' script makes a gated repo where an unchecked push is blocked", (t) => {
  const en = read("README.md").toString("utf8");
  const [script] = bashBlocks(en.slice(en.indexOf("\n## Try it in 5 minutes\n")));
  // The test can't use /tmp, the network or the AI tool, so it swaps those
  // three lines and runs the rest exactly as written.
  const swaps = new Map([
    ["mkdir -p /tmp/comprende-try && cd /tmp/comprende-try", 'cd "$TRY"'],
    ["git clone -q https://github.com/AbdulrahmanMasoud/comprende.git", 'ln -s "$COMPRENDE" comprende'],
    ["claude   # or open this folder in Cursor or Codex", ""],
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

test("the Codex hooks in docs/teams.md are the ones install writes", (t) => {
  const { dev } = setup(t);
  const { hooks } = JSON.parse(readFileSync(join(dev, ".codex/hooks.json"), "utf8"));
  const shell = hooks.PreToolUse[0].hooks[0].command;
  const session = hooks.SessionStart[0].hooks[0].command;
  assert.match(shell, /agent-hook --agent codex$/);
  assert.match(session, /session-start --from-repo --agent codex$/);
  const teams = read("docs/teams.md").toString("utf8");
  for (const command of [shell, session])
    assert.ok(teams.includes(JSON.stringify(command)), `update the snippet: ${command}`);
});

const skill = () => read("skills/comprende/SKILL.md").toString("utf8");
const skillDescription = () => /^description: "(.*)"$/m.exec(skill())?.[1] ?? "";

// Codex skips untrusted plugin hooks without a word, so the skill is what notices.
// It can't load only "in a repo with .learning/config.json": an agent that searched
// with `rg --files` missed the hidden folder and never opened the skill.
test("the skill loads on any code change, not only where an agent's file search finds .learning/", () => {
  const description = skillDescription();
  assert.ok(description.includes("whenever you write, change, or walk through code"), description);
  assert.ok(!description.includes("the user wants to learn"), "no condition on the user's wish to learn");
  assert.ok(!description.includes(".learning"), "loading it must not depend on finding the hidden folder");
});

test("the skill's rule looks for the line every plugin session start begins with", () => {
  const start = gate.const("PLUGIN_LINE_START");
  assert.ok(skill().includes(`a note that begins "${start}"`), `the skill must quote "${start}"`);
  for (const line of [gate.const("ALWAYS_ON"), gate.const("QUIET_MODE")]) assert.ok(line.startsWith(start), line);
});

test("the skill's description fits the Agent Skills limit of 1024 characters", () => {
  assert.ok([...skillDescription()].length <= 1024, `${[...skillDescription()].length} characters`);
});

// The shells an agent's command may run in. zsh is missing on CI's Linux runners,
// and PowerShell (Codex on Windows) has no `test`: there the check finds no gate,
// so the skill stays quiet.
const POSIX_SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((shell) => existsSync(shell));

test("the skill's gate check prints gated only for the repo root's .learning/config.json, tracked or not", (t) => {
  const command = /`(cd "\$\(git rev-parse --show-toplevel\)"[^`]*)`/.exec(skill())?.[1];
  assert.ok(command, "the skill gives one exact command for the gate check");
  for (const shell of POSIX_SHELLS) {
    const gated = (cwd) => sh(cwd, shell, ["-c", command], { check: false }).stdout.trim().endsWith("gated");

    const repo = tmp(t);
    git(repo, "init", "-q");
    write(repo, ".learning/config.json", "{}");
    write(repo, "src/deep/app.js", "");
    assert.ok(gated(repo), `${shell}: untracked, at the root`);
    assert.ok(gated(join(repo, "src/deep")), `${shell}: from a subfolder`);
    commitAll(repo, "gate");
    rmSync(join(repo, ".learning/config.json"));
    assert.ok(gated(repo), `${shell}: tracked, though not on disk`);

    const plain = tmp(t);
    git(plain, "init", "-q");
    write(plain, "packages/a/.learning/config.json", "{}");
    assert.ok(!gated(join(plain, "packages/a")), `${shell}: a config below the root isn't the gate`);
    assert.ok(!gated(tmp(t)), `${shell}: outside a git repo`);
  }
});

// Sanity: SUMMARY and NODE are what the other suites use.
test("the shared test fixtures are usable", () => {
  assert.ok(SUMMARY.length >= 80);
  assert.ok(NODE);
});

test("dist/ and the skill's scripts are checked out byte for byte, whatever core.autocrlf says", () => {
  // SessionStart trusts .learning/gate.mjs only when it equals dist/gate.mjs byte for byte.
  const built = git(REPO, "ls-files", "dist", "skills/comprende/scripts").stdout.trim().split("\n");
  assert.ok(built.includes("dist/gate.mjs") && built.includes("skills/comprende/scripts/gate.mjs"), built.join(", "));
  const attrs = git(REPO, "check-attr", "text", "--", ...built).stdout;
  for (const file of built) assert.ok(attrs.includes(`${file}: text: unset`), attrs);
});

test("the Cursor plugin shares the skill and the MCP server, and its manifest's paths exist", () => {
  const cursor = json(".cursor-plugin/plugin.json");
  assert.equal(cursor.name, json(".claude-plugin/plugin.json").name);
  assert.equal(cursor.skills, "./skills/");
  assert.equal(cursor.mcpServers, "./.mcp.json");
  for (const rel of [cursor.skills, cursor.hooks, cursor.mcpServers, cursor.logo, "skills/comprende/SKILL.md"])
    assert.ok(existsSync(join(REPO, rel)), rel);
  // Only the fields Cursor documents (cursor.com/docs/reference/plugins), plus
  // displayName from Cursor's own plugin template, which Cursor shows by name.
  const documented = [
    "name",
    "displayName",
    "description",
    "version",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "logo",
    "rules",
    "agents",
    "skills",
    "commands",
    "hooks",
    "mcpServers",
    "variables",
  ];
  for (const key of Object.keys(cursor)) assert.ok(documented.includes(key), `${key} isn't a Cursor manifest field`);
  const market = json(".cursor-plugin/marketplace.json");
  assert.deepEqual(
    market.plugins.map((p) => [p.name, p.source]),
    [["comprende", "./"]],
  );
});

test("the Cursor plugin's hook commands are plain node lines that PowerShell can run too", () => {
  const { hooks } = json(json(".cursor-plugin/plugin.json").hooks);
  const entries = Object.entries(hooks).flatMap(([event, list]) => list.map((h) => ({ event, ...h })));
  assert.deepEqual(entries.map((h) => h.event).sort(), ["preToolUse", "sessionStart"]);
  for (const h of entries) {
    // One program and its arguments: no ;, |, &, $(…), backticks, redirects or "command -v".
    assert.match(
      h.command,
      /^node "\$\{CURSOR_PLUGIN_ROOT\}\/dist\/gate\.mjs" (session-start|agent-hook) --from-plugin --agent cursor$/,
    );
    assert.equal(h.failClosed, false, "a hook blocks only on a deliberate exit 2");
    assert.ok(h.timeout > 0);
  }
  assert.equal(entries.find((h) => h.event === "preToolUse").matcher, "Shell");
});

/** The hook commands in a Claude-format hooks file (Claude Code's, Codex's), by event. */
const claudeFormatCommands = (hooks) =>
  Object.entries(hooks).flatMap(([event, groups]) =>
    groups.flatMap((g) => g.hooks.map((h) => ({ event, matcher: g.matcher, ...h }))),
  );
/** The hook commands in a Cursor-format hooks file, by event. */
const cursorFormatCommands = (hooks) =>
  Object.entries(hooks).flatMap(([event, list]) => list.map((h) => ({ event, ...h })));

/** The plugins whose hooks are plain node lines: the tool, its manifest, the
 *  variable it replaces as text before any shell runs, and its hooks' format. */
const NODE_LINE_PLUGINS = [
  {
    tool: "Cursor",
    manifest: ".cursor-plugin/plugin.json",
    variable: "${CURSOR_PLUGIN_ROOT}",
    commandsOf: cursorFormatCommands,
  },
  {
    tool: "Codex",
    manifest: ".codex-plugin/plugin.json",
    variable: "${PLUGIN_ROOT}",
    commandsOf: claudeFormatCommands,
  },
];
const pluginHookCommands = ({ manifest, commandsOf }) => commandsOf(json(json(manifest).hooks).hooks);

test("the Codex plugin shares the skill, has its own hooks, and its MCP config needs no variable", () => {
  const codex = json(".codex-plugin/plugin.json");
  assert.equal(codex.name, json(".claude-plugin/plugin.json").name);
  assert.equal(codex.skills, "./skills/");
  for (const key of ["hooks", "mcpServers"]) assert.ok(codex[key], `the Codex manifest names its own ${key}`);
  for (const rel of [codex.skills, codex.hooks, codex.mcpServers, codex.interface.logo, "skills/comprende/SKILL.md"])
    assert.ok(existsSync(join(REPO, rel)), rel);
  // Only the fields Codex reads (codex-rs/core-plugins/src/manifest.rs at rust-v0.167.1).
  const fields = [
    "name",
    "version",
    "description",
    "keywords",
    "skills",
    "mcpServers",
    "apps",
    "hooks",
    "interface",
    "extensions",
  ];
  for (const key of Object.keys(codex)) assert.ok(fields.includes(key), `${key} isn't a Codex manifest field`);
  // Codex resolves a relative cwd against the plugin's folder (docs/agents.md, "Codex: what we found").
  const server = json(codex.mcpServers).mcpServers.comprende;
  assert.deepEqual(server, { command: "node", args: ["dist/server.mjs"], cwd: "." });
  assert.ok(existsSync(join(REPO, server.args[0])));
});

test("the Codex plugin's hook commands are plain node lines with --agent codex", () => {
  const entries = pluginHookCommands(NODE_LINE_PLUGINS.find((p) => p.tool === "Codex"));
  assert.deepEqual(entries.map((h) => h.event).sort(), ["PreToolUse", "SessionStart"]);
  for (const h of entries) {
    // One program and its arguments, so PowerShell runs it as sh does.
    assert.match(
      h.command,
      /^node "\$\{PLUGIN_ROOT\}\/dist\/gate\.mjs" (session-start|agent-hook) --from-plugin --agent codex$/,
    );
    assert.ok(h.timeout > 0);
  }
  assert.equal(entries.find((h) => h.event === "PreToolUse").matcher, "Bash");
});

for (const plugin of NODE_LINE_PLUGINS) {
  test(`without node, the ${plugin.tool} plugin's hooks fail open`, (t) => {
    const emptyPath = tmp(t);
    for (const h of pluginHookCommands(plugin)) {
      const command = h.command.replaceAll(plugin.variable, REPO);
      // No input: without node the shell exits before reading it, and writing it would race (EPIPE).
      const r = spawnSync("/bin/sh", ["-c", command], {
        cwd: REPO,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { PATH: emptyPath },
      });
      assert.notEqual(r.status, 2, `${h.event}: ${r.stderr}`);
      assert.equal(r.stdout, "", h.event);
    }
  });
}

// On Windows, Cursor and Codex run hook commands in PowerShell, piping the payload in.
// GitHub's runners have pwsh, so this runs in CI. Locally it's skipped without it, and on
// Windows, which has no /bin/sh to look it up with (stdout is then null, not "").
const PWSH = spawnSync("/bin/sh", ["-c", "command -v pwsh"], { encoding: "utf8" }).stdout?.trim() ?? "";

for (const plugin of NODE_LINE_PLUGINS) {
  test(`the ${plugin.tool} plugin's hook commands run in PowerShell, and fail open there without node`, {
    skip: !PWSH,
  }, (t) => {
    const emptyPath = tmp(t);
    const nodeDir = dirname(NODE);
    for (const h of pluginHookCommands(plugin)) {
      const command = `$input | ${h.command.replaceAll(plugin.variable, REPO)}`;
      const run = (path, input) =>
        spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-Command", command], {
          cwd: REPO,
          // Without node there's nothing to read the input, and writing it would race (EPIPE).
          ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input }),
          encoding: "utf8",
          env: { ...ENV, PATH: path },
        });
      const ok = run(`${nodeDir}${delimiter}${process.env.PATH}`, "{}");
      assert.equal(ok.status, 0, `${h.command}: ${ok.stderr}`);
      const noNode = run(emptyPath);
      assert.notEqual(noNode.status, 2, `${h.command}: ${noNode.stderr}`);
      assert.notEqual(noNode.status, 0, `${h.command} should report that node is missing`);
    }
  });
}

/** The hook entries in Antigravity's hooks.json, by event: named groups of events, where a tool
 *  event holds matcher groups, as in Claude Code's format, and a session start a flat list. */
const antigravityFormatCommands = (file) =>
  Object.values(file).flatMap((group) =>
    Object.entries(group).flatMap(([event, list]) =>
      list.flatMap((entry) =>
        entry.hooks ? entry.hooks.map((h) => ({ event, matcher: entry.matcher, ...h })) : [{ event, ...entry }],
      ),
    ),
  );
const antigravityHookCommands = () => antigravityFormatCommands(json("hooks.json"));

/** The one command each Antigravity hook runs, for a gate entry point. Antigravity blocks the tool
 *  call on any non-zero exit, non-JSON stdout or a timeout (docs/agents.md, "Comprende 0.4.3 in
 *  Antigravity"), so the shell, not node, turns every failure into exit 0 with nothing on stdout.
 *  Which shell runs hooks on Windows isn't documented, so it's written for four:
 *  - sh: `set "A=$(…; printf 'x%s' "$?")"` holds the gate's output with `x<its exit code>` at the
 *    end, in $1 (`$(exit 0)` expands to nothing in sh). The `A=` keeps an output that starts with
 *    `-` from being read as an option of `set`. `ok` is "0" when the code is 0 and empty otherwise,
 *    so `reply`, the gate's output, goes out only then.
 *  - cmd.exe: the whole line is one `set "A=…"`, which succeeds: exit 0, and the gate never runs.
 *  - PowerShell 5.1 and 7: `$(exit 0)`, evaluated inside the string, ends the script with 0, and
 *    nothing is printed. `$PLUGIN_ROOT` is an unset PowerShell variable there, so no gate runs.
 *  - The gate is "$PLUGIN_ROOT/dist/gate.mjs", which Antigravity sets for plugin hooks: never a
 *    path a repo can provide, whatever folder the hook runs in. Unset, no gate runs.
 *  The test below checks the rules that keep it so. */
const antigravityCommand = (entryPoint) =>
  `set "A=$(node "$PLUGIN_ROOT/dist/gate.mjs" ${entryPoint} --from-plugin --agent antigravity; printf 'x%s' "$?")$(exit 0)"; ` +
  `held=\${1#A=}; code=\${held##*x}; ok=\${code%%[1-9]*}; reply=\${held%x*}; printf '%s' "\${ok:+$reply}"; exit 0`;
const antigravityPayload = (name, repo) =>
  read(`test/fixtures/antigravity/${name}`).toString("utf8").replaceAll("/work/probe-app", repo);

test("the Antigravity plugin has its own manifest, with only the fields Antigravity documents", () => {
  const antigravity = json(".antigravity-plugin/plugin.json");
  assert.equal(antigravity.name, json(".claude-plugin/plugin.json").name);
  // Its version is in tools/release.mjs's VERSION_FIELDS: Antigravity notices an update by it.
  // Only the fields of Antigravity's schema (antigravity.google/docs/build-plugins): it rejects unknown ones.
  const documented = [
    "$schema",
    "name",
    "displayName",
    "description",
    "version",
    "logo",
    "suggestedPrompts",
    "skills",
    "disabled",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
  ];
  for (const key of Object.keys(antigravity))
    assert.ok(documented.includes(key), `${key} isn't an Antigravity manifest field`);
});

test("the Antigravity plugin's MCP config starts the plugin's own server", () => {
  // Antigravity expands ${PLUGIN_ROOT} in MCP args. A relative path could resolve in the user's repo.
  assert.deepEqual(json("mcp_config.json"), {
    mcpServers: { comprende: { command: "node", args: ["${PLUGIN_ROOT}/dist/server.mjs"] } },
  });
  assert.ok(existsSync(join(REPO, "dist/server.mjs")));
});

test("the Antigravity plugin's hooks file has Antigravity's shape, and runs the plugin's own gate", () => {
  const file = json("hooks.json");
  assert.deepEqual(Object.keys(file), ["comprende"]);
  const { SessionStart, PreToolUse, ...others } = file.comprende;
  assert.deepEqual(others, {});
  // A session start takes a flat list of hooks, and a tool event matcher groups.
  assert.ok(SessionStart.length > 0 && SessionStart.every((h) => h.type === "command" && !("hooks" in h)));
  assert.ok(PreToolUse.length > 0 && PreToolUse.every((g) => g.matcher === "run_command"));
  assert.ok(PreToolUse.every((g) => g.hooks.every((h) => h.type === "command")));
  for (const h of antigravityHookCommands()) {
    assert.equal(h.command, antigravityCommand(h.event === "SessionStart" ? "session-start" : "agent-hook"), h.event);
    assert.ok(h.timeout > 0);
  }
  assert.ok(existsSync(join(REPO, "dist/gate.mjs")));
});

test("Antigravity's hook commands keep the rules that make cmd.exe and PowerShell exit 0 too", () => {
  for (const { event, command } of antigravityHookCommands()) {
    // Windows PowerShell 5.1 can't parse && or ||, and PowerShell 7 stops a chain at an unknown command.
    assert.doesNotMatch(command, /&&|\|\|/, event);
    // cmd.exe runs the line as one `set "A=…"`: it comes first, and & | < > ^ stay inside its quote pairs.
    assert.ok(command.startsWith('set "A='), event);
    const outsideCmdQuotes = command
      .split('"')
      .filter((_, i) => i % 2 === 0)
      .join("");
    assert.doesNotMatch(outsideCmdQuotes, /[&|<>^]/, event);
    // PowerShell ends the script at $(exit 0), so it closes that first statement's string.
    assert.ok(command.split('"; ')[0].endsWith("$(exit 0)"), event);
    // PowerShell can't parse a ${…} inside another.
    assert.doesNotMatch(command, /\$\{[^}]*\$\{/, event);
  }
});

// Antigravity runs hooks with /bin/sh, which is dash on Debian and Ubuntu.
const ANTIGRAVITY_SHELLS = [...POSIX_SHELLS, "/bin/dash"].filter((s) => existsSync(s));

test("Antigravity's hooks let the command run when the gate fails: no node, no gate.mjs, a crash after partial output, exit 2", {
  skip: process.platform === "win32" && "sh only: which shell Antigravity runs hooks in on Windows is unknown",
}, (t) => {
  // A gated repo with an unverified change, where the payloads point.
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  commitAll(dev, "unchecked");
  // The hooks run from a folder with its own dist/gate.mjs, which must never run: the path is
  // $PLUGIN_ROOT's, the plugin's folder, whose dist/gate.mjs each case swaps out.
  const plugin = tmp(t);
  const elsewhere = tmp(t);
  const marker = join(elsewhere, "the-repo-s-own-gate-ran");
  write(
    elsewhere,
    "dist/gate.mjs",
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "");\n`,
  );
  const useGate = (source) => {
    rmSync(join(plugin, "dist"), { recursive: true, force: true });
    if (source !== null) write(plugin, "dist/gate.mjs", source);
  };
  // Each run gets its own claims (in TMPDIR), so no run finds the session or the push
  // already claimed by an earlier one.
  const env = (path, root) => {
    const e = { ...ENV, PATH: path, OWNERSHIP_GATE_NO_AUTO_HOOK: "1", PLUGIN_ROOT: root, TMPDIR: tmp(t) };
    if (root === null) delete e.PLUGIN_ROOT;
    return e;
  };
  const run = (shell, command, input, { path = process.env.PATH, root = plugin } = {}) =>
    spawnSync(shell, ["-c", command], {
      cwd: elsewhere,
      // Without node or gate.mjs nothing may read the input, and writing it would race (EPIPE).
      ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input }),
      encoding: "utf8",
      env: env(path, root),
    });
  const [sessionStart] = antigravityHookCommands().filter((h) => h.event === "SessionStart");
  const [preToolUse] = antigravityHookCommands().filter((h) => h.event === "PreToolUse");
  const start = antigravityPayload("session-start.json", dev);
  const ls = antigravityPayload("pre-tool-use.run-command.ls.json", dev);
  const push = antigravityPayload("pre-tool-use.run-command.git-push.json", dev);
  const partial = '{"decision": "de';
  const deny = '{"decision":"deny","reason":"No ownership report"}';
  assert.ok(ANTIGRAVITY_SHELLS.length > 0);

  for (const shell of ANTIGRAVITY_SHELLS) {
    const allowsSilently = (label, input, options) => {
      for (const h of [sessionStart, preToolUse]) {
        const r = run(shell, h.command, input, options);
        assert.equal(r.status, 0, `${shell}, ${label}, ${h.event}: ${r.stderr}`);
        assert.equal(r.stdout, "", `${shell}, ${label}, ${h.event}`);
      }
    };

    // The real gate. The session start's reply goes out byte for byte: the gate's note as a
    // system message, without the always-on line, which the plugin's rule brings.
    useGate(readFileSync(GATE));
    const direct = spawnSync(NODE, [join(plugin, "dist/gate.mjs"), "session-start", "--from-plugin"], {
      cwd: plugin,
      input: start,
      encoding: "utf8",
      env: env(process.env.PATH, plugin),
    });
    const r = run(shell, sessionStart.command, start);
    assert.equal(r.status, 0, `${shell}: ${r.stderr}`);
    assert.equal(r.stdout, direct.stdout, shell);
    const context = JSON.parse(r.stdout).injectSteps[0].systemMessage.systemMessage;
    assert.match(context, /ownership gate \(mode: required\)/, shell);
    assert.doesNotMatch(context, /Comprende is installed/, shell);
    // A command gets an empty allow, and the unverified push a JSON deny on exit 0.
    const allowed = run(shell, preToolUse.command, ls);
    assert.deepEqual([allowed.status, allowed.stdout], [0, ""], `${shell}: ${allowed.stderr}`);
    const blocked = run(shell, preToolUse.command, push);
    assert.equal(blocked.status, 0, `${shell}: ${blocked.stderr}`);
    assert.equal(JSON.parse(blocked.stdout).decision, "deny", shell);
    assert.match(JSON.parse(blocked.stdout).reason, /No ownership report for branch/, shell);

    allowsSilently("node missing from PATH", undefined, { path: tmp(t) });
    allowsSilently("PLUGIN_ROOT unset", ls, { root: null });
    useGate(null);
    allowsSilently("gate.mjs missing", ls);

    // Partial JSON on stdout, written for sure (writeSync), then a crash.
    useGate(
      `import { writeSync } from "node:fs";\nwriteSync(1, ${JSON.stringify(partial)});\nthrow new Error("a crash");\n`,
    );
    const crash = sh(plugin, NODE, ["dist/gate.mjs"], { check: false });
    assert.deepEqual([crash.stdout, crash.status !== 0], [partial, true], "the stand-in prints, then crashes");
    allowsSilently("a crash after partial output", ls);

    useGate('process.stderr.write("Blocked by the ownership gate\\n");\nprocess.exitCode = 2;\n');
    allowsSilently("exit 2", push);

    // A deliberate deny, which Antigravity reads as JSON on exit 0, goes out unchanged.
    useGate(`process.stdout.write(${JSON.stringify(deny)});\n`);
    const denied = run(shell, preToolUse.command, push);
    assert.deepEqual([denied.status, denied.stdout], [0, deny], `${shell}: ${denied.stderr}`);
  }
  assert.ok(!existsSync(marker), "the folder's own dist/gate.mjs ran");
});

test("Antigravity's hook commands exit 0 in PowerShell 7 too, with or without node", { skip: !PWSH }, (t) => {
  for (const h of antigravityHookCommands()) {
    for (const path of [`${dirname(NODE)}${delimiter}${process.env.PATH}`, tmp(t)]) {
      const r = spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-Command", h.command], {
        cwd: REPO,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...ENV, PATH: path, PLUGIN_ROOT: REPO },
      });
      assert.equal(r.status, 0, `${h.event}: ${r.stderr}`);
      assert.equal(r.stdout, "", h.event);
    }
  }
});

// On Windows, which shell Antigravity runs hooks in isn't documented: its build names both
// cmd.exe and PowerShell. So the commands must exit 0 with nothing on stdout in each of them.
// Only the Windows workflow runs this.
test("on Windows, Antigravity's hook commands exit 0 silently in cmd.exe and both PowerShells, with or without node", {
  skip: process.platform !== "win32" && "Windows only",
}, (t) => {
  // Full paths: without node, the child's PATH is an empty folder, where Windows wouldn't find the shell either.
  const onPath = (name) =>
    spawnSync("where.exe", [name], { encoding: "utf8" }).stdout?.split(/\r?\n/)[0]?.trim() || name;
  const cmd = process.env.ComSpec ?? onPath("cmd.exe");
  const shells = [
    { name: "cmd.exe", program: cmd, args: (c) => ["/d", "/s", "/c", `"${c}"`], verbatim: true },
    // Quoted the way Go's os/exec quotes an argument (Antigravity's CLI is a Go program).
    { name: "cmd.exe, Go-style quoting", program: cmd, args: (c) => ["/c", c], verbatim: false },
    {
      name: "PowerShell 7",
      program: onPath("pwsh.exe"),
      args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c],
    },
    {
      name: "Windows PowerShell 5.1",
      program: onPath("powershell.exe"),
      args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c],
    },
  ];
  for (const shell of shells) {
    for (const h of antigravityHookCommands()) {
      for (const [label, path] of [
        ["with node", `${dirname(NODE)}${delimiter}${process.env.PATH}`],
        ["without node", tmp(t)],
      ]) {
        const r = spawnSync(shell.program, shell.args(h.command), {
          cwd: REPO,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
          windowsVerbatimArguments: shell.verbatim === true,
          env: { ...ENV, PATH: path, PLUGIN_ROOT: REPO, SystemRoot: process.env.SystemRoot },
        });
        t.diagnostic(
          `${shell.name}, ${h.event}, ${label}: exit ${r.status}, stdout ${JSON.stringify(r.stdout)}, stderr ${JSON.stringify((r.stderr ?? "").slice(0, 200))}`,
        );
        assert.equal(r.status, 0, `${shell.name}, ${h.event}, ${label}: ${r.stderr}`);
        assert.equal(r.stdout, "", `${shell.name}, ${h.event}, ${label}`);
      }
    }
  }
});

test("each tool picks up only its own manifest, hooks and MCP config", () => {
  // How each tool finds a plugin's parts, from its docs or source (docs/agents.md):
  // - manifests: where it looks, in order; the first one found wins
  // - hooks: the file it reads when the manifest names none, and whether a named
  //   one replaces that default or adds to it
  // - mcp: the same for the MCP config, and the variables it expands there
  const tools = {
    "Claude Code": {
      own: ".claude-plugin",
      manifests: [".claude-plugin/plugin.json"],
      hooks: {
        default: "hooks/hooks.json",
        named: "adds",
        commandsOf: (f) => claudeFormatCommands(f.hooks),
        agent: null,
      },
      mcp: { default: ".mcp.json", expands: ["${CLAUDE_PLUGIN_ROOT}"] },
    },
    Cursor: {
      own: ".cursor-plugin",
      manifests: [".cursor-plugin/plugin.json", "plugin.json"],
      hooks: {
        default: "hooks/hooks.json",
        named: "replaces",
        commandsOf: (f) => cursorFormatCommands(f.hooks),
        agent: "cursor",
      },
      mcp: { default: "mcp.json", expands: ["${CURSOR_PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}"] },
    },
    Codex: {
      own: ".codex-plugin",
      // The source's list starts at .codex-plugin/. The docs also accept a root
      // plugin.json (Agent Plugins) without saying where it comes, so it's first here.
      manifests: [
        "plugin.json",
        ".codex-plugin/plugin.json",
        ".claude-plugin/plugin.json",
        ".cursor-plugin/plugin.json",
      ],
      hooks: {
        default: "hooks/hooks.json",
        named: "replaces",
        commandsOf: (f) => claudeFormatCommands(f.hooks),
        agent: "codex",
      },
      mcp: { default: ".mcp.json", expands: [] },
    },
    Antigravity: {
      own: ".antigravity-plugin",
      manifests: [".antigravity-plugin/plugin.json", "plugin.json", ".gemini-plugin/plugin.json"],
      // Its manifest can't name a hooks file.
      hooks: { default: "hooks.json", named: "replaces", commandsOf: antigravityFormatCommands, agent: "antigravity" },
      mcp: { default: "mcp_config.json", expands: ["${PLUGIN_ROOT}"] },
    },
  };
  // A root plugin.json would be read by Cursor, Codex and Antigravity alike.
  assert.ok(!existsSync(join(REPO, "plugin.json")), "no plugin.json at the root");
  const readers = new Map();
  for (const [tool, { own, manifests, hooks, mcp }] of Object.entries(tools)) {
    const found = manifests.find((m) => existsSync(join(REPO, m)));
    assert.ok(found, `${tool} finds no manifest`);
    assert.equal(found, `${own}/plugin.json`, `${tool} reads another tool's manifest`);
    const manifest = json(found);
    const relative = (path) => path.replace(/^\.\//, "");
    const hookFiles = !manifest.hooks
      ? [hooks.default]
      : hooks.named === "adds"
        ? [hooks.default, relative(manifest.hooks)]
        : [relative(manifest.hooks)];
    for (const file of hookFiles) {
      assert.ok(!readers.has(file), `${tool} and ${readers.get(file)} read the same hooks file, ${file}`);
      readers.set(file, tool);
      // Every gate command in it says which tool runs it (Claude Code's detects instead).
      const commands = hooks
        .commandsOf(json(file))
        .map((h) => h.command)
        .filter((c) => c.includes("gate.mjs"));
      assert.ok(commands.length > 0, `${file} runs the gate`);
      for (const c of commands) assert.equal(/--agent ([\w-]+)/.exec(c)?.[1] ?? null, hooks.agent, `${file}: ${c}`);
    }
    // Its MCP config names only variables this tool expands.
    const mcpFile = manifest.mcpServers ? relative(manifest.mcpServers) : mcp.default;
    assert.ok(existsSync(join(REPO, mcpFile)), `${tool}'s MCP config, ${mcpFile}`);
    for (const variable of readFileSync(join(REPO, mcpFile), "utf8").match(/\$\{[A-Z_]+\}/g) ?? [])
      assert.ok(mcp.expands.includes(variable), `${tool} doesn't expand ${variable} in ${mcpFile}`);
  }
});
