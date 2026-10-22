// The plugin's files agree with each other: manifests, built copies, docs and the demo.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ENV, NODE, REPO, SUMMARY, sh, tmp } from "./helpers.mjs";

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

test("both READMEs open with a Quick start for the three kinds of user", () => {
  const en = read("README.md").toString("utf8");
  const quick = en.indexOf("## Quick start");
  assert.ok(quick > 0 && quick < en.indexOf("## Install"), "Quick start comes before Install");
  const section = en.slice(quick, en.indexOf("\n## ", quick + 1));
  for (const who of ["Solo developer", "Team lead", "Team member"]) assert.ok(section.includes(who), who);
  assert.ok(section.includes("Enable the ownership gate in this repo") && section.includes("protect"));
  assert.ok(section.includes("docs/demo.tape"));
  assert.ok(
    section.includes("](docs/demo.gif)") && existsSync(join(REPO, "docs/demo.gif")),
    "the demo GIF is embedded",
  );
  const ar = read("README.ar.md").toString("utf8");
  const arQuick = ar.indexOf("## البداية السريعة");
  assert.ok(arQuick > 0 && arQuick < ar.indexOf("## التسطيب"), "Arabic Quick start comes before التسطيب");
  assert.ok(ar.includes("/plugin install comprende@comprende"));
  assert.ok(ar.includes("](docs/demo.gif)"), "the Arabic README embeds the demo GIF too");
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
  const pushed = out.indexOf("pushed: feature/sum");
  assert.ok(blocked >= 0 && saved > blocked && pushed > saved, out);
});

// Sanity: SUMMARY and NODE are what the other suites use.
test("the shared test fixtures are usable", () => {
  assert.ok(SUMMARY.length >= 80);
  assert.ok(NODE);
});
