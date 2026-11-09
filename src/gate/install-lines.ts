// Install's one-line edits to files the repo already owns (.gitignore and
// .gitattributes): adding each line once, and recognising exactly that edit as
// gate plumbing, so the PR that installs the gate has nothing to verify.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lstat } from "../util.js";
import type { Change } from "./changes.js";
import { atomicWrite, MAX_CONFIG_BYTES, readRepoFile } from "./files.js";
import { readBlob } from "./git.js";
import { GATE_ATTRIBUTES_LINE, GateError, REPORT_INPUT, splitLines, ZERO_SHA } from "./shared.js";

// The lines install adds. A line with a feature is exempt only when the gate CI
// runs lists that feature (see GATE_FEATURES in shared.ts).
export const INSTALL_LINES: readonly { file: string; line: string; feature?: string }[] = [
  { file: ".gitignore", line: REPORT_INPUT },
  { file: ".gitattributes", line: GATE_ATTRIBUTES_LINE, feature: "gitattributes" },
];

/** `text` with `line` appended as its own line: what install writes. */
function withLine(text: Buffer, line: string): Buffer {
  const sep = text.length && text[text.length - 1] !== 0x0a ? "\n" : "";
  return Buffer.concat([text, Buffer.from(`${sep}${line}\n`)]);
}

/** Add one of INSTALL_LINES to the repo's `file` (created if missing), keeping its lines. */
export function addInstallLine(root: string, file: string, line: string): string {
  const path = join(root, file);
  const st = lstat(path);
  if (st && (st.isSymbolicLink() || !st.isFile()))
    return `SKIPPED ${file}: not a regular file; add ${line} to it by hand.`;
  let text = Buffer.alloc(0);
  if (st) {
    try {
      text = Buffer.from(readRepoFile(path, MAX_CONFIG_BYTES), "utf8");
      if (!text.equals(readFileSync(path))) throw new GateError("it isn't valid UTF-8");
    } catch (e) {
      return `SKIPPED ${file}: ${(e as Error).message}; add ${line} to it by hand.`;
    }
  }
  // The same line, also anchored with a leading "/" or spaced differently.
  const sameLine = (l: string) => l.trim().replace(/^\//, "").split(/\s+/).join(" ") === line;
  if (splitLines(text.toString("utf8")).some(sameLine)) return `${file} already has ${line}`;
  atomicWrite(path, withLine(text, line).toString("utf8"));
  return `added ${line} to ${file}`;
}

/** One of install's one-line edits (INSTALL_LINES): the old file plus exactly
 *  that line, byte for byte. Any other edit to those files is a change. This
 *  keeps the PR that installs the gate free of anything to verify. A line with
 *  a feature is exempt only when the gate CI runs lists it: an older CI gate
 *  counts it as a change, and a newer local gate must never pass what CI fails. */
export function isInstallLineEdit(
  root: string,
  path: string,
  c: Change,
  ciGateHas: (feature: string) => boolean,
): boolean {
  const edit = INSTALL_LINES.find((e) => e.file === path);
  if (!edit || c.mode !== "100644") return false;
  if (edit.feature && !ciGateHas(edit.feature)) return false;
  const before = c.base === ZERO_SHA ? Buffer.alloc(0) : c.base_mode === "100644" ? readBlob(root, c.base) : null;
  const after = readBlob(root, c.blob);
  if (!before || !after) return false;
  return after.equals(withLine(before, edit.line));
}
