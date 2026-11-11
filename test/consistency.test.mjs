// The plugin's files agree with each other: manifests, built copies, docs and the demo.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
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
    ["claude   # or open this folder in Cursor", ""],
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

test("the Codex hook in docs/teams.md is the one install writes", (t) => {
  const { dev } = setup(t);
  const { command } = JSON.parse(readFileSync(join(dev, ".codex/hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0];
  assert.match(command, /agent-hook --agent codex$/);
  assert.ok(read("docs/teams.md").toString("utf8").includes(JSON.stringify(command)), "update the snippet");
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
// GitHub's runners have pwsh, so this runs in CI. Locally it's skipped without it.
const PWSH = spawnSync("/bin/sh", ["-c", "command -v pwsh"], { encoding: "utf8" }).stdout.trim();

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
      hooks: { default: "hooks/hooks.json", named: "adds", commandsOf: claudeFormatCommands, agent: null },
      mcp: { default: ".mcp.json", expands: ["${CLAUDE_PLUGIN_ROOT}"] },
    },
    Cursor: {
      own: ".cursor-plugin",
      manifests: [".cursor-plugin/plugin.json", "plugin.json"],
      hooks: { default: "hooks/hooks.json", named: "replaces", commandsOf: cursorFormatCommands, agent: "cursor" },
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
      hooks: { default: "hooks/hooks.json", named: "replaces", commandsOf: claudeFormatCommands, agent: "codex" },
      mcp: { default: ".mcp.json", expands: [] },
    },
    Antigravity: {
      own: ".antigravity-plugin",
      manifests: [".antigravity-plugin/plugin.json", "plugin.json", ".gemini-plugin/plugin.json"],
      hooks: {
        default: "hooks.json",
        named: "replaces",
        commandsOf: (h) => Object.values(h).flatMap((g) => claudeFormatCommands(g)),
        agent: "antigravity",
      },
      mcp: { default: "mcp_config.json", expands: ["${PLUGIN_ROOT}"] },
    },
  };
  // A root plugin.json would be read by Cursor, Codex and Antigravity alike.
  assert.ok(!existsSync(join(REPO, "plugin.json")), "no plugin.json at the root");
  const readers = new Map();
  for (const [tool, { own, manifests, hooks, mcp }] of Object.entries(tools)) {
    const found = manifests.find((m) => existsSync(join(REPO, m)));
    // Antigravity's comes in 0.5.0: until then it finds none of these.
    if (!found) {
      assert.equal(tool, "Antigravity", `${tool} finds no manifest`);
      continue;
    }
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
        .commandsOf(json(file).hooks)
        .map((h) => h.command)
        .filter((c) => c.includes("gate.mjs"));
      assert.ok(commands.length > 0, `${file} runs the gate`);
      for (const c of commands) assert.equal(/--agent (\S+)/.exec(c)?.[1] ?? null, hooks.agent, `${file}: ${c}`);
    }
    // Its MCP config names only variables this tool expands.
    const mcpFile = manifest.mcpServers ? relative(manifest.mcpServers) : mcp.default;
    assert.ok(existsSync(join(REPO, mcpFile)), `${tool}'s MCP config, ${mcpFile}`);
    for (const variable of readFileSync(join(REPO, mcpFile), "utf8").match(/\$\{[A-Z_]+\}/g) ?? [])
      assert.ok(mcp.expands.includes(variable), `${tool} doesn't expand ${variable} in ${mcpFile}`);
  }
});
