// The files that control the gate. They're excluded from "the change to
// understand" and protected by CODEOWNERS review instead.

import { PROJECT_HOOK_FILES } from "./agents/index.js";
import { REPO_PLATFORM } from "./platforms/index.js";
import { CONFIG_PATH, GATE_REL } from "./shared.js";

export const GATE_FILES: readonly string[] = [
  CONFIG_PATH,
  GATE_REL,
  REPO_PLATFORM.ciConfig.path,
  ...PROJECT_HOOK_FILES.map((f) => f.path),
  REPO_PLATFORM.codeowners.paths[0],
];

/** The gate feature that made `path` a gate file, for the files added after the
 *  first release: an edit to one counts as a change until the gate CI runs knows it. */
export const gateFileFeature = (path: string): string | undefined =>
  PROJECT_HOOK_FILES.find((f) => f.path === path)?.feature;
