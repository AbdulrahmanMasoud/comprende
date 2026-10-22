// Does a shell command push? What the Claude hook treats as a push.

import assert from "node:assert/strict";
import { test } from "node:test";
import { gate } from "./helpers.mjs";

const PUSH_CASES = [
  ["git push", true],
  ["git push -u origin feature/x", true],
  ["git -C /repo push", true],
  ["git add -A && git commit -m 'x' && git push", true],
  ["GIT_TRACE=1 git push --force-with-lease", true],
  ["/usr/bin/git push", true],
  ["gh pr create --fill", true],
  ["gh pr merge 12", true],
  ["git stash push -m wip", false],
  ["echo 'git push'", false],
  ["git status", false],
  ["gh pr view", false],
  ["npm run push", false],
];

for (const [cmd, expected] of PUSH_CASES) {
  test(`${JSON.stringify(cmd)} ${expected ? "is" : "is not"} a push`, () => {
    assert.equal(gate.isPushCommand(cmd), expected); // strict: `is True` / `is False`
  });
}

// Push detection: wrappers, subshells, gh -R, continuations; quoted text isn't a command.
for (const [cmd, expected] of [
  ['bash -c "git push"', true],
  ["sh -lc 'git push origin HEAD'", true],
  ["(git push)", true],
  ["{ git push; }", true],
  ["sudo git push", true],
  ["sudo -u deploy git push", true],
  ["env GIT_SSH_COMMAND=ssh git push", true],
  ["command git push", true],
  ["time git push", true],
  ["gh -R acme/app pr merge 3", true],
  ["gh --repo acme/app pr create", true],
  ["git \\\npush", true],
  ["git add -A\ngit push", true],
  ['git commit -m "wip; git push later"', false],
  ['git commit -m "a && git push"', false],
  ["echo git push", false],
]) {
  test(`${JSON.stringify(cmd)} ${expected ? "is" : "is not"} a push (edge case)`, () => {
    assert.equal(gate.isPushCommand(cmd), expected);
  });
}

// Unicode spaces aren't shell word separators: no false "push" blocks.
test("push detection splits words on shell whitespace only", () => {
  assert.equal(gate.isPushCommand("git push"), false);
  assert.equal(gate.isPushCommand("git commit -m fix#1 && git push"), true);
  assert.equal(gate.isPushCommand("echo a#b; git push"), true);
  assert.equal(gate.isPushCommand("git push # later"), true);
});
