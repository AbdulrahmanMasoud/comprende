// GitHub: the Actions workflow install writes, the PR's branch from the Actions
// environment, the job summary and annotations reviewers see, CODEOWNERS, and the
// repository ruleset that protect creates through the GitHub CLI (gh).

import { isRecord } from "../../util.js";
import { type RunResult, run } from "../run.js";
import { GATE_REL, GateError } from "../shared.js";
import type { Platform, ProtectOptions } from "./types.js";

const WORKFLOW = `name: Ownership check

on:
  pull_request:
    # 'edited' re-runs the check when a PR is retargeted to another base branch.
    types: [opened, synchronize, reopened, edited, labeled, unlabeled]

permissions:
  contents: read

jobs:
  ownership:
    name: Ownership check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          # Check the PR's own commit (not GitHub's merge commit) with full history,
          # so fingerprints match what the developer verified.
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 0

      - uses: actions/setup-node@v7
        with:
          node-version: 24
          # The gate needs no dependencies; a restored cache is only a way in.
          package-manager-cache: false

      - name: Verify ownership report
        env:
          BASE_REF: \${{ github.base_ref }}
          HEAD_REF: \${{ github.head_ref }}
          PR_LABELS: \${{ toJSON(github.event.pull_request.labels.*.name) }}
          NODE_OPTIONS: ""
        run: |
          # Run the gate as it exists on the base branch, so a PR can't weaken it
          # by editing ${GATE_REL}. Falls back to the PR's copy only when the base
          # doesn't have the gate yet (the PR that installs it); the rules then
          # are the strict defaults, not the PR's own config.
          if git cat-file -e "origin/$BASE_REF:${GATE_REL}" 2>/dev/null; then
            git show "origin/$BASE_REF:${GATE_REL}" > "$RUNNER_TEMP/gate.mjs"
          else
            cp ${GATE_REL} "$RUNNER_TEMP/gate.mjs"
          fi
          node "$RUNNER_TEMP/gate.mjs" verify --repo . --base "origin/$BASE_REF" \\
            --branch "$HEAD_REF" --labels-json "$PR_LABELS"
`;

// The workflow job's name, which is also the status check's name.
const CHECK_NAME = "Ownership check";

const RULESET_NAME = "Ownership gate";

// Where to do by hand what the gate couldn't do itself.
const REQUIRE_BY_HAND =
  "https://github.com/AbdulrahmanMasoud/comprende/blob/main/docs/teams.md#make-the-check-required";

/** A repository ruleset for the default branch. Rulesets layer on top of
 *  existing branch protection (the strictest rule wins), so creating one never
 *  weakens or replaces what a repo already has. */
function rulesetBody(approvals = 1, codeOwners = true) {
  return {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: approvals,
          require_code_owner_review: codeOwners,
          dismiss_stale_reviews_on_push: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: "required_status_checks",
        parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: CHECK_NAME }] },
      },
    ],
  };
}

function runGh(root: string, args: string[], input?: string): string {
  let r: RunResult;
  try {
    r = run("gh", args, { cwd: root, input });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GateError(
        `The GitHub CLI (gh) isn't installed. Install it and run \`gh auth login\`, or make the check required by hand: ${REQUIRE_BY_HAND}`,
      );
    }
    throw new GateError(`gh ${args.slice(0, 2).join(" ")} failed: ${(e as Error).message}`);
  }
  if (r.status !== 0) {
    const err = (r.stderr.toString("utf8") || r.stdout.toString("utf8")).trim();
    const low = err.toLowerCase();
    if (err.includes("Upgrade to GitHub Pro") || (low.includes("upgrade") && low.includes("plan"))) {
      throw new GateError(
        `Rulesets aren't available for private repos on GitHub's free plan. Use Settings → Branches → branch protection instead: ${REQUIRE_BY_HAND}`,
      );
    }
    if (err.includes("403") || err.includes("Must have admin rights") || err.includes("Resource not accessible")) {
      throw new GateError("GitHub refused: creating rules needs admin access to this repository.");
    }
    throw new GateError(`gh ${args.slice(0, 2).join(" ")} failed: ${err}`);
  }
  return r.stdout.toString("utf8");
}

/** Create the GitHub ruleset that makes the gate binding: PRs required, the
 *  'Ownership check' status required, code-owner review for gate files.
 *  Without apply it only shows what it would do. */
function protect(root: string, { apply, approvals, codeOwners }: ProtectOptions): string[] {
  if (!Number.isInteger(approvals) || approvals < 0 || approvals > 10)
    throw new GateError("--approvals must be between 0 and 10.");
  const nwo = runGh(root, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(nwo))
    throw new GateError(`Couldn't tell which GitHub repo this is (got ${JSON.stringify(nwo)}).`);
  let existing: unknown = [];
  try {
    existing = JSON.parse(runGh(root, ["api", `repos/${nwo}/rulesets`]) || "[]");
  } catch (e) {
    if (e instanceof GateError) throw e;
  }
  for (const r of Array.isArray(existing) ? existing : []) {
    if (isRecord(r) && r.name === RULESET_NAME)
      return [`Ruleset '${RULESET_NAME}' already exists on ${nwo}: https://github.com/${nwo}/rules/${String(r.id)}`];
  }
  const body = rulesetBody(approvals, codeOwners);
  const plan = [
    `Ruleset for ${nwo} (default branch): require a pull request with ${approvals} approval(s)` +
      (codeOwners ? " incl. code owners" : "") +
      `, and the '${CHECK_NAME}' status check.`,
    "It adds to existing branch protection; it doesn't replace it.",
  ];
  if (codeOwners)
    plan.push("Note: a code owner can't approve their own PR. On a one-person repo, use --no-code-owners.");
  if (!apply)
    return [
      ...plan,
      "Dry run — nothing changed. Rerun with --apply (needs admin) to create it.",
      JSON.stringify(body, null, 2),
    ];
  let created: unknown = {};
  try {
    created = JSON.parse(
      runGh(root, ["api", "-X", "POST", `repos/${nwo}/rulesets`, "--input", "-"], JSON.stringify(body)) || "{}",
    );
  } catch (e) {
    if (e instanceof GateError) throw e;
  }
  return [...plan, `Created: https://github.com/${nwo}/rules/${String(isRecord(created) ? created.id : undefined)}`];
}

export const github: Platform = {
  id: "github",

  detects: (env) => env.GITHUB_ACTIONS === "true",

  ciConfig: {
    path: ".github/workflows/ownership-check.yml",
    withGateJob: (existing, shownPath) =>
      existing === null
        ? { content: WORKFLOW, message: `wrote ${shownPath}` }
        : { message: `${shownPath} exists (kept)` },
  },

  checkName: CHECK_NAME,

  // The workflow passes the base branch and the labels as flags; only the head
  // branch also comes from the environment.
  ciContext: (env) => ({ baseRef: null, headBranch: env.GITHUB_HEAD_REF || null, labels: null }),

  reviewerSummaryFile: (env) => env.GITHUB_STEP_SUMMARY || null,

  annotations: (kind, messages, env) =>
    env.GITHUB_ACTIONS === "true" ? messages.map((m) => `::${kind} title=Ownership check::${m}\n`).join("") : "",

  codeowners: {
    path: ".github/CODEOWNERS",
    ownerPattern: /^(?:@[\w.-]+(?:\/[\w.-]+)?|[^@\s]+@[^@\s]+)$/,
    ownerHint: "a GitHub @user, @org/team, or an email",
    reviewSetting: "'Require review from Code Owners'",
  },

  cli: {
    program: "gh",
    optionsWithValue: new Set(["-R", "--repo", "--hostname"]),
    publishes: [
      ["pr", "create"],
      ["pr", "merge"],
    ],
  },

  protect,
};
