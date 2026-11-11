// Two plugin copies of the gate can run on the same hook event in Cursor: the
// Claude Code plugin it imports and its own. They can't see each other, so each
// claims the event's id, and only the copy that claims it first checks. A claim
// is an empty file in a private folder under the system temp folder.

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The folder for claims: one per user, readable only by them. Null when it
 *  can't be made safely, and then every copy checks. */
function claimsFolder(): string | null {
  try {
    const dir = join(tmpdir(), `comprende-hook-runs-${userInfo().uid}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = statSync(dir);
    // Another user could have made the folder first, to suppress our checks.
    if (!st.isDirectory() || (typeof process.getuid === "function" && st.uid !== process.getuid())) return null;
    return dir;
  } catch {
    return null;
  }
}

/** Old claims go, so the folder doesn't grow. Best effort. */
function prune(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (Date.now() - statSync(path).mtimeMs > DAY_MS) rmSync(path, { force: true });
    }
  } catch {
    /* the next claim tries again */
  }
}

/** True when this run should check: it claimed `key` first, or claims can't be
 *  made. False when another copy already claimed it. */
export function claimHookRun(key: string): boolean {
  const dir = claimsFolder();
  if (!dir) return true;
  try {
    closeSync(openSync(join(dir, createHash("sha256").update(key).digest("hex")), "wx"));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "EEXIST";
  }
  if (Math.random() < 0.05) prune(dir);
  return true;
}
