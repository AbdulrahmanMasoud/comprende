// The files that control the gate. They're excluded from "the change to
// understand" and protected by CODEOWNERS review instead.

import { PROJECT_HOOK_FILES } from "./agents/index.js";
import { CONFIG_PATH, GATE_REL } from "./shared.js";

export const GATE_FILES: readonly string[] = [
  CONFIG_PATH,
  GATE_REL,
  ".github/workflows/ownership-check.yml",
  ...PROJECT_HOOK_FILES.map((f) => f.path),
  ".github/CODEOWNERS",
];
