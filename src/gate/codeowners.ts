// The CODEOWNERS entries install suggests or adds, so changes to the gate's own
// files need the lead's review. The platform says where the file goes and which
// owners it accepts.

import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { lstat } from "../util.js";
import { atomicWrite, MAX_CONFIG_BYTES, readExisting } from "./files.js";
import { GATE_FILES } from "./gate-files.js";
import { REPO_PLATFORM } from "./platforms/index.js";
import { GateError, splitLines } from "./shared.js";

/** The CODEOWNERS the platform reads: the first that exists in its search order,
 *  else the first place, which hides nothing. Adding anywhere else would either
 *  be ignored or hide the repo's own file, whose rules would then stop applying.
 *  The name must match exactly, since GitHub is case-sensitive and a macOS disk
 *  isn't, and a directory is skipped, as GitHub skips it. */
function codeownersInUse(root: string, paths: readonly string[]): string {
  return (
    paths.find((p) => {
      const abs = join(root, p);
      const st = lstat(abs);
      if (!st || st.isDirectory()) return false;
      try {
        return readdirSync(dirname(abs)).includes(basename(abs));
      } catch {
        return false;
      }
    }) ?? paths[0]
  );
}

export function setUpCodeowners(root: string, owner?: string | null): string {
  const { paths, ownerPattern, ownerHint, reviewSetting } = REPO_PLATFORM.codeowners;
  const rel = codeownersInUse(root, paths);
  // The entry that protects CODEOWNERS itself names the file in use.
  const lines = GATE_FILES.map((p) => `/${paths.includes(p) ? rel : p} ${owner || "@your-team-lead"}`);
  if (!owner) {
    return (
      `MANUAL STEP 2: add to ${rel} (or rerun install with --owner @handle) and turn on ${reviewSetting} — otherwise a PR could edit the workflow to skip the check:\n  ` +
      lines.join("\n  ")
    );
  }
  if (!ownerPattern.test(owner)) throw new GateError(`--owner must be ${ownerHint}; got ${JSON.stringify(owner)}.`);
  const path = join(root, rel);
  const found = lstat(path) ? readExisting(path, MAX_CONFIG_BYTES) : null;
  if (found && "unreadable" in found)
    return `SKIPPED CODEOWNERS: ${found.unreadable} (${rel}). Add these lines to it by hand:\n  ${lines.join("\n  ")}`;
  const existing = found?.text ?? "";
  const have = new Set(
    splitLines(existing)
      .filter((l) => l.trim() && !l.trimStart().startsWith("#"))
      .map((l) => l.trim().split(/\s+/)[0]),
  );
  const fresh = lines.filter((l) => !have.has(l.split(/\s+/)[0]));
  if (fresh.length) {
    const prefix = !existing || existing.endsWith("\n") ? "" : "\n";
    atomicWrite(
      path,
      `${existing + prefix}# Ownership gate: changes to the gate need lead review\n${fresh.join("\n")}\n`,
    );
  }
  return `CODEOWNERS: ${fresh.length} entries added to ${rel} for ${owner}. MANUAL STEP 2: turn on ${reviewSetting} in branch protection.`;
}
