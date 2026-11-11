// Names, paths and small helpers that every part of the gate uses.
import { fileURLToPath } from "node:url";

export const GATE_VERSION = 3;

// What this gate accepts beyond its version, written into the bundle's header
// by build.mjs. A gate only offers a feature locally when the copy CI runs
// lists it too (see features.ts).
// - small-change: the fast path for small changes
// - gitattributes: install's one .gitattributes line (GATE_ATTRIBUTES_LINE) needs no report
export const GATE_FEATURES = "small-change gitattributes";

const LEARNING = ".learning";

export const CHECKS_DIR = `${LEARNING}/checks`;

export const CONFIG_PATH = `${LEARNING}/config.json`;

export const GATE_REL = `${LEARNING}/gate.mjs`;

// Scratch input for `save --input` when the MCP tool isn't available. It's
// plumbing at exactly this path, install adds it to .gitignore, and a
// successful save deletes it.
export const REPORT_INPUT = `${LEARNING}/report.local.json`;

// The .gitattributes line install adds. Without it, git's core.autocrlf checks
// gate.mjs out with CRLF on Windows, and the copy is then never byte-identical
// to the plugin's, so SessionStart can't trust it and installs no pre-push hook.
export const GATE_ATTRIBUTES_LINE = `${GATE_REL} -text`;

export const ZERO_SHA = "0".repeat(40);

export const REGULAR_MODES = ["100644", "100755"];

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

/** A path as it appears in a message: control characters escaped (\n, \r, \t,
 *  \xNN), so a file name from a PR can't start a line of its own in any output.
 *  GitHub's runner reads a line starting with "::" as a workflow command. */
export function printablePath(path: string): string {
  let out = "";
  for (const ch of path) {
    const code = ch.charCodeAt(0);
    if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out;
}
