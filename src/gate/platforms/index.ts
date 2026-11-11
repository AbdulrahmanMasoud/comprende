// The registry of git platform adapters, and which one applies: the platform
// whose CI is running, and the one install and protect set up.

import { github } from "./github.js";
import type { CiEnv, Platform } from "./types.js";

export const PLATFORMS: readonly Platform[] = [github];

/** The platform install, protect and GATE_FILES use. GitHub is the only one so
 *  far. With a second platform, the repo's config will name it (#4). */
export const REPO_PLATFORM: Platform = github;

/** The platform whose CI is running, else the repo's platform. */
export const ciPlatform = (env: CiEnv): Platform => PLATFORMS.find((p) => p.detects(env)) ?? REPO_PLATFORM;

export type { AnnotationKind, CiContext, CiEnv, Platform, PlatformId, ProtectOptions } from "./types.js";
