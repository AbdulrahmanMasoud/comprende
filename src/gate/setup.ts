// Turning the gate on for a repo: install (gate copy, config, CI workflow, Claude hook,
// .gitignore line, CODEOWNERS) and protect (the GitHub ruleset that makes the check required).
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withIgnoreLine } from "./changes.js";
import { DEFAULT_CONFIG } from "./config.js";
import { MAX_CONFIG_BYTES, atomicWrite, exists, lstat, readSmall } from "./files.js";
import { RunResult, repoRoot, resolveBase, run } from "./git.js";
import { installHooks } from "./hooks.js";
import { CONFIG_PATH, GATE_FILES, GATE_REL, GateError, REPORT_INPUT, SELF, isObj, splitLines } from "./shared.js";

export const WORKFLOW = `name: Ownership check

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
      - uses: actions/checkout@v4
        with:
          # Check the PR's own commit (not GitHub's merge commit) with full history,
          # so fingerprints match what the developer verified.
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 22

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

// Without node, exit 0: any other non-2 code would still be shown as a hook error on every Bash call.
const CLAUDE_HOOK_COMMAND = `command -v node >/dev/null 2>&1 || exit 0; exec node "$CLAUDE_PROJECT_DIR/${GATE_REL}" claude-hook`;

const RULESET_NAME = "Ownership gate";

export const CHECK_NAME = "Ownership check";

// the workflow job's name = the status check context

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
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: CHECK_NAME }] } },
    ],
  };
}

function gh(root: string, args: string[], input?: string): string {
  let r: RunResult;
  try {
    r = run("gh", args, { cwd: root, input });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GateError("The GitHub CLI (gh) isn't installed. Install it and run `gh auth login`, or set this up by hand: see the README's 'Protect the branch' section.");
    }
    throw new GateError(`gh ${args.slice(0, 2).join(" ")} failed: ${(e as Error).message}`);
  }
  if (r.status !== 0) {
    const err = (r.stderr.toString("utf8") || r.stdout.toString("utf8")).trim();
    const low = err.toLowerCase();
    if (err.includes("Upgrade to GitHub Pro") || (low.includes("upgrade") && low.includes("plan"))) {
      throw new GateError("Rulesets aren't available for private repos on GitHub's free plan. Use Settings → Branches → branch protection instead (see README).");
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
  if (!Number.isInteger(approvals) || approvals < 0 || approvals > 10) throw new GateError("--approvals must be between 0 and 10.");
  const nwo = gh(root, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(nwo)) throw new GateError(`Couldn't tell which GitHub repo this is (got ${JSON.stringify(nwo)}).`);
  let existing: unknown = [];
  try {
    existing = JSON.parse(gh(root, ["api", `repos/${nwo}/rulesets`]) || "[]");
  } catch (e) {
    if (e instanceof GateError) throw e;
  }
  for (const r of Array.isArray(existing) ? existing : []) {
    if (isObj(r) && r.name === RULESET_NAME) return [`Ruleset '${RULESET_NAME}' already exists on ${nwo}: https://github.com/${nwo}/rules/${String(r.id)}`];
  }
  const body = rulesetBody(approvals, codeOwners);
  const plan = [
    `Ruleset for ${nwo} (default branch): require a pull request with ${approvals} approval(s)` + (codeOwners ? " incl. code owners" : "") + `, and the '${CHECK_NAME}' status check.`,
    "It adds to existing branch protection; it doesn't replace it.",
  ];
  if (codeOwners) plan.push("Note: a code owner can't approve their own PR. On a one-person repo, use --no-code-owners.");
  if (!apply) return [...plan, "Dry run — nothing changed. Rerun with --apply (needs admin) to create it.", JSON.stringify(body, null, 2)];
  let created: unknown = {};
  try {
    created = JSON.parse(gh(root, ["api", "-X", "POST", `repos/${nwo}/rulesets`, "--input", "-"], JSON.stringify(body)) || "{}");
  } catch (e) {
    if (e instanceof GateError) throw e;
  }
  return [...plan, `Created: https://github.com/${nwo}/rules/${String(isObj(created) ? created.id : undefined)}`];
}

export function mergeClaudeSettings(path: string): string {
  let settings: Record<string, unknown> = {};
  if (lstat(path)) {
    let raw: string;
    try {
      raw = readSmall(path, MAX_CONFIG_BYTES);
    } catch (e) {
      return `SKIPPED Claude hook: ${(e as Error).message}`;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      return `SKIPPED Claude hook: ${path} is not valid JSON; add the hook by hand (see README).`;
    }
    if (!isObj(parsed)) return `SKIPPED Claude hook: ${path} is not a JSON object; add the hook by hand.`;
    settings = parsed;
  }
  // Never replace a value we don't understand: that would drop the user's settings.
  if (settings.hooks !== undefined && !isObj(settings.hooks))
    return `SKIPPED Claude hook: "hooks" in ${path} is not an object; add the hook by hand.`;
  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  if (hooks.PreToolUse !== undefined && !Array.isArray(hooks.PreToolUse))
    return `SKIPPED Claude hook: "hooks.PreToolUse" in ${path} is not a list; add the hook by hand.`;
  const groups = (hooks.PreToolUse ??= []) as { hooks?: { command?: string }[] }[];
  for (const g of groups) {
    for (const h of g?.hooks ?? []) {
      if ((h?.command ?? "").includes("gate.mjs") && (h?.command ?? "").includes("claude-hook")) return `Claude hook already present (${path})`;
    }
  }
  groups.push({ matcher: "Bash", hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND, timeout: 60 }] } as never);
  atomicWrite(path, JSON.stringify(settings, null, 2) + "\n");
  return `merged a Claude Code PreToolUse hook into ${path} (other settings kept)`;
}

/** Add REPORT_INPUT to the repo's .gitignore (created if missing), keeping its lines. */
function ignoreReportInput(root: string): string {
  const path = join(root, ".gitignore");
  const st = lstat(path);
  if (st && (st.isSymbolicLink() || !st.isFile())) return `SKIPPED .gitignore: not a regular file; add ${REPORT_INPUT} to it by hand.`;
  let text = Buffer.alloc(0);
  if (st) {
    try {
      text = Buffer.from(readSmall(path, MAX_CONFIG_BYTES), "utf8");
      if (!text.equals(readFileSync(path))) throw new GateError("it isn't valid UTF-8");
    } catch (e) {
      return `SKIPPED .gitignore: ${(e as Error).message}; add ${REPORT_INPUT} to it by hand.`;
    }
  }
  if (splitLines(text.toString("utf8")).some((l) => [REPORT_INPUT, `/${REPORT_INPUT}`].includes(l.trim()))) {
    return `.gitignore already ignores ${REPORT_INPUT}`;
  }
  atomicWrite(path, withIgnoreLine(text).toString("utf8"));
  return `added ${REPORT_INPUT} to .gitignore`;
}

function codeowners(root: string, owner?: string | null): string {
  const lines = GATE_FILES.map((p) => `/${p} ${owner || "@your-team-lead"}`);
  if (!owner) {
    return "MANUAL STEP 2: add to .github/CODEOWNERS (or rerun install with --owner @handle) and turn on 'Require review from Code Owners' — otherwise a PR could edit the workflow to skip the check:\n  " + lines.join("\n  ");
  }
  if (!/^(?:@[\w.-]+(?:\/[\w.-]+)?|[^@\s]+@[^@\s]+)$/.test(owner)) throw new GateError(`--owner must be a GitHub @user, @org/team, or an email; got ${JSON.stringify(owner)}.`);
  const path = join(root, ".github", "CODEOWNERS");
  const existing = exists(path) ? readFileSync(path, "utf8") : "";
  const have = new Set(splitLines(existing).filter((l) => l.trim() && !l.trimStart().startsWith("#")).map((l) => l.trim().split(/\s+/)[0]));
  const fresh = lines.filter((l) => !have.has(l.split(/\s+/)[0]));
  if (fresh.length) {
    const prefix = !existing || existing.endsWith("\n") ? "" : "\n";
    atomicWrite(path, existing + prefix + "# Ownership gate: changes to the gate need lead review\n" + fresh.join("\n") + "\n");
  }
  return `CODEOWNERS: ${fresh.length} entries added for ${owner}. MANUAL STEP 2: turn on 'Require review from Code Owners' in branch protection.`;
}

export function install(repo?: string | null, upgrade = false, owner?: string | null): string[] {
  const root = repoRoot(repo);
  const done: string[] = [];
  const target = join(root, GATE_REL);
  if (!SELF) throw new GateError("Can't locate this gate's own file to install it.");
  if (exists(target) && resolve(target) === resolve(SELF)) done.push(`${GATE_REL} is this file`);
  else if (exists(target) && !upgrade) {
    const same = readFileSync(target).equals(readFileSync(SELF));
    done.push(`${GATE_REL} ` + (same ? "up to date" : "exists (pass --upgrade to replace)"));
  } else {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(SELF, target);
    chmodSync(target, 0o755);
    done.push(`wrote ${GATE_REL}`);
  }

  const cfgPath = join(root, CONFIG_PATH);
  if (exists(cfgPath)) done.push(`${CONFIG_PATH} exists (kept)`);
  else {
    const cfg = { ...DEFAULT_CONFIG };
    try {
      const b = resolveBase(root, { base: "" }, null);
      cfg.base = b.includes("/") ? b.slice(b.indexOf("/") + 1) : b;
    } catch {
      cfg.base = "main";
    }
    atomicWrite(cfgPath, JSON.stringify({ ownership_check: cfg }, null, 2) + "\n");
    done.push(`wrote ${CONFIG_PATH} (base: ${cfg.base}, mode: required)`);
  }

  const wf = join(root, ".github", "workflows", "ownership-check.yml");
  const wfRel = ".github/workflows/ownership-check.yml";
  if (exists(wf)) done.push(`${wfRel} exists (kept)`);
  else {
    atomicWrite(wf, WORKFLOW);
    done.push(`wrote ${wfRel}`);
  }

  done.push(mergeClaudeSettings(join(root, ".claude", "settings.json")));
  done.push(ignoreReportInput(root));
  done.push(...installHooks(root));
  done.push(`NEXT, after this is merged: run \`node ${GATE_REL} protect\` (dry run, then --apply) to require the '${CHECK_NAME}' status on the default branch — without it CI only warns.`);
  done.push(codeowners(root, owner));
  return done;
}
