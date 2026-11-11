// The CODEOWNERS entries install suggests or adds, so changes to the gate's own
// files need the lead's review. The platform says where the file goes and which
// owners it accepts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./files.js";
import { GATE_FILES } from "./gate-files.js";
import { REPO_PLATFORM } from "./platforms/index.js";
import { GateError, splitLines } from "./shared.js";

export function setUpCodeowners(root: string, owner?: string | null): string {
  const { paths, ownerPattern, ownerHint, reviewSetting } = REPO_PLATFORM.codeowners;
  const rel = paths[0]; // #33: should be the first one that exists
  const lines = GATE_FILES.map((p) => `/${p} ${owner || "@your-team-lead"}`);
  if (!owner) {
    return (
      `MANUAL STEP 2: add to ${rel} (or rerun install with --owner @handle) and turn on ${reviewSetting} — otherwise a PR could edit the workflow to skip the check:\n  ` +
      lines.join("\n  ")
    );
  }
  if (!ownerPattern.test(owner)) throw new GateError(`--owner must be ${ownerHint}; got ${JSON.stringify(owner)}.`);
  const path = join(root, rel);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
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
  return `CODEOWNERS: ${fresh.length} entries added for ${owner}. MANUAL STEP 2: turn on ${reviewSetting} in branch protection.`;
}
