// A gate's header: the version and features lines build.mjs writes at the top of
// gate.mjs. Gates read each other's headers to know what the copy CI runs can do:
// a gate offers a feature locally only when that copy lists it too, so local and
// CI always agree.

import { join } from "node:path";
import { MAX_GATE_BYTES, readRepoFile } from "./files.js";
import { readFileAtRev, revHasFile } from "./git.js";
import { FEATURES_RE, GATE_REL } from "./shared.js";

/** The top of the gate.mjs at `rev` (the working tree's when rev is null), where
 *  its header is; "" when there's no such file or it can't be read. */
export function gateHeader(root: string, rev: string | null): string {
  try {
    if (rev === null) return readRepoFile(join(root, GATE_REL), MAX_GATE_BYTES).slice(0, 4096);
    if (!revHasFile(root, rev, GATE_REL)) return "";
    return readFileAtRev(root, rev, GATE_REL, MAX_GATE_BYTES).slice(0, 4096);
  } catch {
    return "";
  }
}

/** Does the gate CI runs list `feature`? CI runs the base branch's copy, or the
 *  change's own copy while the base doesn't have the gate yet (the PR that
 *  installs it): rev's, or the working tree's when rev is null. */
export function ciGateHasFeature(root: string, baseRef: string, rev: string | null, feature: string): boolean {
  const header = revHasFile(root, baseRef, GATE_REL) ? gateHeader(root, baseRef) : gateHeader(root, rev);
  return (FEATURES_RE.exec(header)?.[1] ?? "").trim().split(/\s+/).includes(feature);
}
