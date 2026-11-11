// The interface every git platform's adapter implements: the CI config install
// writes, what CI tells the gate about the change, where reviewers see the result,
// CODEOWNERS, and making the check required. See CONTRIBUTING.md, "Adding a git platform".

import type { ExistingFile } from "../files.js";

/** The platforms the gate has an adapter for. */
export type PlatformId = "github";

/** The CI environment, read-only. */
export type CiEnv = Readonly<Record<string, string | undefined>>;

/** What CI says about the change it's checking. A null field means CI doesn't
 *  say: the command's own flags (--base, --branch, --labels-json) decide, and
 *  they win when given. */
export interface CiContext {
  /** The ref to compare against, as `--base` takes it (e.g. "origin/main"). */
  readonly baseRef: string | null;
  /** The pull or merge request's branch, as the developer named it. */
  readonly headBranch: string | null;
  /** The request's labels, for the skip label. */
  readonly labels: readonly string[] | null;
}

export type AnnotationKind = "error" | "warning" | "notice";

export interface ProtectOptions {
  readonly apply: boolean;
  readonly approvals: number;
  readonly codeOwners: boolean;
}

export interface Platform {
  /** For the registry, and later for the repo's config. */
  readonly id: PlatformId;

  /** Is the gate running in this platform's CI? */
  detects(env: CiEnv): boolean;

  /** The CI config that runs the check on every pull or merge request. */
  readonly ciConfig: {
    /** The path from the repo root. */
    readonly path: string;
    /** The content with the gate's job added, plus what install reports. No
     *  content means leave the file alone. Pure: the core does the write. A
     *  platform whose CI lives in one shared file (GitLab's .gitlab-ci.yml)
     *  merges its job in here, instead of writing a file of its own. */
    withGateJob(existing: ExistingFile, shownPath: string): { readonly content?: string; readonly message: string };
  };

  /** The name CI reports the check under, which protect makes required. */
  readonly checkName: string;

  /** What this CI's environment says about the change. */
  ciContext(env: CiEnv): CiContext;

  /** The file the reviewer summary (markdown) is appended to in this CI, or
   *  null when there's nowhere to show it. */
  reviewerSummaryFile(env: CiEnv): string | null;

  /** The stdout text that shows `messages` as annotations in this CI, or ""
   *  when it has none. */
  annotations(kind: AnnotationKind, messages: readonly string[], env: CiEnv): string;

  /** CODEOWNERS: where the file goes, which owners it accepts, and the setting
   *  that makes code-owner review required. */
  readonly codeowners: {
    readonly path: string;
    readonly ownerPattern: RegExp;
    /** For the error message, e.g. "a GitHub @user, @org/team, or an email". */
    readonly ownerHint: string;
    /** The setting's name as the platform shows it, quoted. */
    readonly reviewSetting: string;
  };

  /** The platform's CLI, and its commands that open or merge a pull request: the
   *  agent hook treats them like `git push`. */
  readonly cli: {
    readonly program: string;
    /** Global options that take a value, which come before the subcommand. */
    readonly optionsWithValue: ReadonlySet<string>;
    /** Subcommand pairs, such as ["pr", "create"]. */
    readonly publishes: readonly (readonly [string, string])[];
  };

  /** Make the check required on the default branch, in the repo at `root`.
   *  Without `apply`, only say what it would do. Returns what to print. */
  protect(root: string, options: ProtectOptions): string[];
}
