import assert from "node:assert/strict";
import { test } from "node:test";
import { gate, gateCli, git, payload, setup, write } from "./helpers.mjs";

const ALWAYS_ON = gate.const("ALWAYS_ON");

test("antigravity session-start outputs injectSteps with ALWAYS_ON", () => {
  const result = gate.antigravitySessionStart(JSON.stringify({}));
  assert.ok(result.injectSteps);
  assert.equal(result.injectSteps.length, 1);
  assert.ok(result.injectSteps[0].systemMessage.systemMessage.includes(ALWAYS_ON));
});

test("antigravity session-start in a gated repo mentions the ownership gate", (t) => {
  const { dev } = setup(t);
  const input = JSON.stringify({ workspacePaths: [dev] });
  const result = gate.antigravitySessionStart(input);
  assert.ok(result.injectSteps);
  const msg = result.injectSteps[0].systemMessage.systemMessage;
  assert.ok(msg.includes("ownership gate (mode: required)"));
});

test("antigravity-pre-tool-use allows non-push commands", (t) => {
  const { dev } = setup(t);
  const input = JSON.stringify({
    toolCall: {
      name: "run_command",
      args: { CommandLine: "npm test" },
    },
    workspacePaths: [dev],
  });
  const res = gate.antigravityPreToolUse(input);
  assert.equal(res.decision, "allow");
});

test("antigravity-pre-tool-use blocks unverified push in gated repo", (t) => {
  const { dev } = setup(t);
  write(dev, "src/app.js", "export const app = 2;\n");
  git(dev, "commit", "-qam", "unchecked change");

  const input = JSON.stringify({
    toolCall: {
      name: "run_command",
      args: { CommandLine: "git push origin feature/rate-limit" },
    },
    workspacePaths: [dev],
  });

  const res = gate.antigravityPreToolUse(input);
  assert.equal(res.decision, "deny");
  assert.ok(res.reason.includes("Blocked by the ownership gate"));

  // Save report but do not commit it -> still denied because uncommitted
  gate.save(payload(), dev);
  const resPending = gate.antigravityPreToolUse(input);
  assert.equal(resPending.decision, "deny");
  assert.ok(resPending.reason.includes("saved but not committed"));

  // Commit report -> allowed!
  git(dev, "add", "-A");
  git(dev, "commit", "-qm", "ownership report");
  const resAllowed = gate.antigravityPreToolUse(input);
  assert.equal(resAllowed.decision, "allow");
});

test("gate CLI responds to antigravity commands via CLI", (t) => {
  const { dev } = setup(t);
  const input = JSON.stringify({ workspacePaths: [dev] });
  const r = gateCli(["antigravity-session-start"], { input });
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.injectSteps);
});
