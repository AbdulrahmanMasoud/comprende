// tools/e2e-common.mjs, the part of the end-to-end tools that needs no AI tool: the
// log of every gate.mjs run, the gated demo repo, the plugin's copy, and the scenario
// runner. The tools themselves run by hand, so a change that breaks these would
// otherwise go unseen.

import assert from "node:assert/strict";
import { readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import {
  askedQuestion,
  Blocked,
  beforeFirst,
  copyPlugin,
  gateLog,
  makeDemo,
  remoteHas,
  runScenarios,
} from "../tools/e2e-common.mjs";
import { GATE, NODE, REPO, REPO_GATE, sh, tmp } from "./helpers.mjs";

test("the gate log records a gate.mjs run: which copy, its arguments, folder, exit code and output", (t) => {
  const run = tmp(t);
  const gate = gateLog(run);
  const r = sh(run, NODE, [GATE, "--help"], { env: { ...process.env, NODE_OPTIONS: gate.nodeOptions } });
  const runs = gate.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].script, GATE);
  assert.deepEqual(runs[0].argv, ["--help"]);
  assert.equal(runs[0].cwd, realpathSync.native(run));
  assert.equal(runs[0].exit, 0);
  assert.equal(runs[0].stdout, r.stdout);
});

test("the gate log skips other scripts, and an empty log has no runs", (t) => {
  const run = tmp(t);
  const gate = gateLog(run);
  sh(run, NODE, ["-e", "console.log('not the gate')"], { env: { ...process.env, NODE_OPTIONS: gate.nodeOptions } });
  assert.deepEqual(gate.runs(), []);
});

test("the gate log's runs since a point, of some subcommands only", (t) => {
  const run = tmp(t);
  const gate = gateLog(run);
  const env = { ...process.env, NODE_OPTIONS: gate.nodeOptions };
  sh(run, NODE, [GATE, "--help"], { env });
  sh(run, NODE, [GATE, "status", "--json"], { env, check: false });
  assert.equal(gate.runsSince(0).length, 2);
  assert.deepEqual(
    gate.runsSince(1).map((r) => r.argv[0]),
    ["status"],
  );
  assert.deepEqual(
    gate.runsSince(0, ["--help", "session-start"]).map((r) => r.argv[0]),
    ["--help"],
  );
});

test("the demo repo: the gate on main, and an unverified change on feature/sum that isn't pushed", (t) => {
  const run = tmp(t);
  const { app, remote } = makeDemo(run, "demo");
  assert.equal(remoteHas(remote, "main"), true);
  assert.equal(remoteHas(remote, "feature/sum"), false);
  assert.equal(sh(app, "git", ["branch", "--show-current"]).stdout.trim(), "feature/sum");
  const verdict = JSON.parse(sh(app, NODE, [REPO_GATE, "verify", "--json"], { check: false }).stdout);
  assert.equal(verdict.passed, false);
  assert.match(verdict.messages.join("\n"), /No ownership report for branch 'feature\/sum'/);
});

test("a demo left by an earlier run in the same folder is replaced", (t) => {
  const run = tmp(t);
  makeDemo(run, "demo");
  const { remote } = makeDemo(run, "demo");
  assert.equal(remoteHas(remote, "feature/sum"), false);
  assert.equal(sh(join(run, "demo", "app"), "git", ["rev-list", "--count", "HEAD"]).stdout.trim(), "3");
});

test("scenarios: a blocked one is reported and the next still runs; an unknown name is an error", () => {
  const ran = [];
  const blocked = [];
  const steps = { blocked: (name, message) => blocked.push(`${name}: ${message}`) };
  const scenarios = [
    {
      name: "first",
      run: () => {
        ran.push("first");
        throw new Blocked("usage limit");
      },
    },
    { name: "second", run: () => ran.push("second") },
    { name: "third", run: () => ran.push("third") },
  ];
  runScenarios(scenarios, ["first", "second"], steps);
  assert.deepEqual(ran, ["first", "second"]);
  assert.deepEqual(blocked, ["first: usage limit"]);
  assert.throws(() => runScenarios(scenarios, ["fourth"], steps), /no such scenario: fourth/);
  assert.throws(
    () =>
      runScenarios(
        [
          {
            name: "crash",
            run: () => {
              throw new Error("a bug");
            },
          },
        ],
        undefined,
        steps,
      ),
    /a bug/,
  );
});

test("the plugin's copy has every file git tracks, and nothing else", (t) => {
  const copy = copyPlugin(tmp(t), "plugin");
  const files = (/** @type {string} */ dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => relative(copy, join(e.parentPath, e.name)).replaceAll("\\", "/"))
      .sort();
  const tracked = sh(REPO, "git", ["ls-files"]).stdout.trim().split("\n").sort();
  assert.deepEqual(files(copy), tracked);
});

test("a setup runs once, before the first scenario that needs it", () => {
  const order = [];
  const withSetup = beforeFirst(() => order.push("setup"));
  const first = withSetup(() => order.push("first"));
  const second = withSetup(() => order.push("second"));
  second();
  first();
  assert.deepEqual(order, ["setup", "second", "first"]);
});

test("a question is a question in English or in Arabic, in any of the replies", () => {
  assert.equal(askedQuestion("Done.", "Why is 0 the starting value?"), true);
  assert.equal(askedQuestion("ليه الـ 0 هو القيمة الأولى؟"), true);
  assert.equal(askedQuestion("Saved the report.", ""), false);
});
