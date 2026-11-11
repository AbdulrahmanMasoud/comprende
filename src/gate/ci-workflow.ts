// The text of the CI workflow that install writes, and the name of the status
// check it reports, which protect makes required.

import { GATE_REL } from "./shared.js";

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
export const CHECK_NAME = "Ownership check";
