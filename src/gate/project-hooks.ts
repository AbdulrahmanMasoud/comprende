// The repo-level hook files that agent adapters describe (agents/types.ts): the
// safe read, the atomic write, and whether one already runs the gate. The adapter
// decides the content; this module only touches the disk.

import { lstat } from "../util.js";
import type { ProjectHookFile } from "./agents/index.js";
import { atomicWrite, MAX_CONFIG_BYTES, readRepoFile } from "./files.js";

/** Add the gate's hook to the file at `path` (created if missing), keeping the rest. */
export function addProjectHook(path: string, file: ProjectHookFile): string {
  let existing: string | null = null;
  if (lstat(path)) {
    try {
      existing = readRepoFile(path, MAX_CONFIG_BYTES);
    } catch (e) {
      return `SKIPPED ${file.label}: ${(e as Error).message}`;
    }
  }
  const { content, message } = file.withGateHook(existing, path);
  if (content !== undefined) atomicWrite(path, content);
  return message;
}

/** Does the hook file at `path` already run the gate? False when it's missing or
 *  can't be read safely. */
export function projectHookRunsGate(path: string, file: ProjectHookFile): boolean {
  try {
    return file.runsGate(readRepoFile(path, MAX_CONFIG_BYTES));
  } catch {
    return false;
  }
}
