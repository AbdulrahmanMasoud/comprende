// Claims for hook-copies.ts: copies of the gate on the same hook event claim its
// id, and only the first to claim it speaks. A claim is an empty file, named by
// the key's hash, in a private folder under the system temp folder.
//
// Another user can't use claims to suppress a check. The folder must be a real
// folder (not a symlink), ours and private, or nothing is claimed and every copy
// checks. And the ids in the keys (a tool call's, a session's) aren't known
// before the event, so a claim can't be made in advance.

import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The copies of one event start within moments of each other. A claim older
 *  than this (longer than any hook's timeout) is stale: a later event that
 *  reuses the id, like a resumed session, is a new one. */
const STALE_MS = 2 * 60 * 1000;

const CLAIM_NAME = /^[0-9a-f]{64}$/;

/** The folder for claims: one per user, private to them. Null when it isn't
 *  safe, and then every copy checks. */
function claimsFolder(): string | null {
  try {
    // getuid is missing on Windows, where the temp folder is already the user's own.
    const uid = process.getuid?.();
    const dir = join(tmpdir(), `comprende-hook-runs-${uid ?? "user"}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory()) return null;
    // On a shared /tmp another user could have made it first, or made it readable.
    if (uid !== undefined && (st.uid !== uid || (st.mode & 0o077) !== 0)) return null;
    return dir;
  } catch {
    return null;
  }
}

/** Stale claims go, so the folder stays small. Only claim names: nothing else
 *  should be there, and nothing else is ours to delete. Best effort. If two
 *  copies race on a stale claim with their own key, at worst both check. */
function prune(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!CLAIM_NAME.test(name)) continue;
      const path = join(dir, name);
      if (Date.now() - lstatSync(path).mtimeMs > STALE_MS) rmSync(path, { force: true });
    }
  } catch {
    /* the next claim tries again */
  }
}

/** True when this run should speak: it claimed `key` first, or claims can't be
 *  made. False when another copy already claimed it. */
export function claimHookRun(key: string): boolean {
  const dir = claimsFolder();
  if (!dir) return true;
  prune(dir);
  try {
    closeSync(openSync(join(dir, createHash("sha256").update(key).digest("hex")), "wx"));
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "EEXIST";
  }
}
