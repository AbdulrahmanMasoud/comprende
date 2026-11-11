// protect: the GitHub ruleset that makes the ownership check required, created
// through the GitHub CLI (gh). A dry run by default.

import { isRecord } from "../util.js";
import { CHECK_NAME } from "./ci-workflow.js";
import { type RunResult, repoRoot, run } from "./git.js";
import { GateError } from "./shared.js";

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
export function protect(repo?: string | null, apply = false, approvals = 1, codeOwners = true): string[] {
  const root = repoRoot(repo);
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
