// Names, paths and small helpers that every part of the gate uses.
import { fileURLToPath } from "node:url";

export const GATE_VERSION = 3;

// What this gate accepts beyond its version, written into the bundle's header
// by build.mjs. A gate only offers a feature locally when the base branch's
// copy (the one CI runs) lists it too.
export const GATE_FEATURES = "small-change";

const LEARNING = ".learning";

export const CHECKS_DIR = `${LEARNING}/checks`;

export const CONFIG_PATH = `${LEARNING}/config.json`;

export const GATE_REL = `${LEARNING}/gate.mjs`;

// Scratch input for `save --input` when the MCP tool isn't available. It's
// plumbing at exactly this path, install adds it to .gitignore, and a
// successful save deletes it.
export const REPORT_INPUT = `${LEARNING}/report.local.json`;

export const ZERO_SHA = "0".repeat(40);

export const REGULAR_MODES = ["100644", "100755"];

// Files that control the gate. They're excluded from "the change to
// understand" and protected by CODEOWNERS review instead.
export const GATE_FILES = [
  CONFIG_PATH,
  GATE_REL,
  ".github/workflows/ownership-check.yml",
  ".claude/settings.json",
  ".github/CODEOWNERS",
];

export class GateError extends Error {}

export const SELF = (() => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return ""; // e.g. loaded from a data: URL by the pinned pre-push hook
  }
})();

export const sorted = <T>(xs: Iterable<T>): T[] => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export const splitLines = (s: string): string[] => {
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
};

export const VERSION_RE = /^\/\/ ownership-gate-version: (\d+)/m;

export const FEATURES_RE = /^\/\/ ownership-gate-features: (.*)$/m;
