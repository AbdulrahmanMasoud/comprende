// The repo-level hook files that agent adapters describe (agents/types.ts): the
// safe read, the atomic write, and whether one already runs the gate. The adapter
// decides the content; this module only touches the disk.

import { lstat } from "../util.js";
import type { ProjectHookFile } from "./agents/index.js";
import { atomicWrite, MAX_CONFIG_BYTES, readExisting, readRepoFile } from "./files.js";

/** Add the gate's hook to the file at `path` (created if missing), keeping the rest. */
export function addProjectHook(path: string, file: ProjectHookFile): string {
  // lstat, not existsSync: a dangling symlink is there, and must not be written through.
  const { content, message } = file.withGateHook(lstat(path) ? readExisting(path) : null, path);
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
