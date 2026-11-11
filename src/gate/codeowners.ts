// The CODEOWNERS entries install suggests or adds, so changes to the gate's own
// files need the lead's review.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./files.js";
import { GATE_FILES, GateError, splitLines } from "./shared.js";

export function setUpCodeowners(root: string, owner?: string | null): string {
  const lines = GATE_FILES.map((p) => `/${p} ${owner || "@your-team-lead"}`);
  if (!owner) {
    return (
      "MANUAL STEP 2: add to .github/CODEOWNERS (or rerun install with --owner @handle) and turn on 'Require review from Code Owners' — otherwise a PR could edit the workflow to skip the check:\n  " +
      lines.join("\n  ")
    );
  }
  if (!/^(?:@[\w.-]+(?:\/[\w.-]+)?|[^@\s]+@[^@\s]+)$/.test(owner))
    throw new GateError(`--owner must be a GitHub @user, @org/team, or an email; got ${JSON.stringify(owner)}.`);
  const path = join(root, ".github", "CODEOWNERS");
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
  return `CODEOWNERS: ${fresh.length} entries added for ${owner}. MANUAL STEP 2: turn on 'Require review from Code Owners' in branch protection.`;
}
