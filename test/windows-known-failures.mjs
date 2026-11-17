// The tests that still fail on Windows, and why. The Windows workflow runs the suite
// through tools/windows-tests.mjs, which expects each of these to fail on win32 with
// the error in `fails`. It turns the run red when a test that isn't here fails, when
// one of these fails with another error, passes or doesn't run. So a fix shows up as a
// red run, and its entry comes off this list in the same PR.
//
// Each cause is part of Windows support, #10, which says more about each one. None is
// a bug in the gate: they're tests that assume Linux or macOS.

/** The `test` of an entry for a file that crashes while it loads: its tests after the crash never run. */
export const WHOLE_FILE = "(the whole file)";

/** @param {string} cause */
const issue10 = (cause) => ({ issue: 10, cause });

const POSIX_SHELL = issue10(
  "Runs a hook command, or looks a program up, through /bin/sh, which Node on Windows can't find (section 1).",
);
const RAW_PATH_IN_JSON = issue10(
  "Puts a Windows path into a captured payload's JSON as raw text, so its backslashes break the JSON. The gate then reads a broken payload and lets the command run, as it must.",
);
const TMPDIR_ONLY = issue10(
  "Points the gate's temp folder through TMPDIR, which Node on Windows doesn't read: os.tmpdir() reads TEMP and TMP.",
);
const CRLF_CHECKOUT = issue10(
  "Reads a text file that Git for Windows checked out with CRLF line endings (core.autocrlf=true) (section 4).",
);
const SHORT_PATH = issue10(
  "Compares a path that keeps Windows' 8.3 short name (RUNNER~1) with its long form (section 6).",
);
const NTFS_NAME = issue10("Makes a file named :weird.js, which NTFS doesn't allow (section 6).");
const FILE_MODE = issue10(
  "Needs an executable file, and Git for Windows commits it as 100644 (core.fileMode=false) (section 3).",
);
const NUL_CONFIG = issue10(
  "Sets GIT_CONFIG_GLOBAL to os.devNull (\\\\.\\nul), which git on Windows can't open (section 6).",
);
const CRLF_EDIT = issue10(
  "Edits a checked-out file by replacing text that ends in \\n, which a CRLF checkout doesn't have, so there's no sneaky edit to catch (section 4).",
);
const MSYS_PATHS = issue10(
  "Git Bash rewrites the workflow's origin/<base>:.learning/gate.mjs argument as a path list, so the PR's copy of the gate runs (section 7).",
);
const FAKE_GH = issue10(
  "Its fake gh is an extensionless script, which Node on Windows doesn't run for a bare command name, so the runner's real gh.exe runs instead (section 7).",
);
const GIT_EXE = issue10("Looks for git on PATH by the name git, not git.exe (section 7).");
const MSYS_FIFO = issue10("Git Bash's mkfifo makes an MSYS emulation, not a real FIFO (section 5).");

/**
 * `fails` is a part of the error the test fails with on Windows: for a whole file, of
 * the crash it prints.
 * @type {readonly { file: string, test: string, fails: string, issue: number, cause: string }[]}
 */
export const WINDOWS_KNOWN_FAILURES = [
  {
    file: "test/agents.test.mjs",
    test: WHOLE_FILE,
    fails: "Cannot read properties of undefined (reading 'trim')",
    ...issue10(
      "Looks pwsh up through /bin/sh while the file loads (const PWSH), which Node on Windows can't find, so the file stops there and its tests after that line never run (section 1).",
    ),
  },
  {
    file: "test/agents.test.mjs",
    test: "in Codex, the plugin's hook checks a push even though the repo has .claude/settings.json",
    fails: "0 !== 2",
    ...RAW_PATH_IN_JSON,
  },
  {
    file: "test/agents.test.mjs",
    test: "each tool's messages name that tool, and CI's name none",
    fails: "did not match the regular expression /Ask Cursor to run the ownership check/",
    ...RAW_PATH_IN_JSON,
  },
  {
    file: "test/agents.test.mjs",
    test: "from Claude Code, a real payload's unverified push is blocked, and ls passes silently",
    fails: "spawnSync /bin/sh ENOENT",
    ...POSIX_SHELL,
  },
  {
    file: "test/agents.test.mjs",
    test: "agent-hook and claude-hook are the same command",
    fails: "Bad escaped character in JSON",
    ...RAW_PATH_IN_JSON,
  },
  {
    file: "test/agents.test.mjs",
    test: "from Claude Code, session start finds the repo through the payload's cwd",
    fails: "did not match the regular expression /This repository uses the ownership gate",
    ...RAW_PATH_IN_JSON,
  },
  {
    file: "test/agents.test.mjs",
    test: "agent-hook --agent cursor blocks an unverified push from a Cursor payload",
    fails: "0 !== 2",
    ...RAW_PATH_IN_JSON,
  },
  {
    file: "test/agents.test.mjs",
    test: "the Cursor plugin's hooks, run as Cursor runs them, block an unverified push and stay silent otherwise",
    fails: "spawnSync /bin/sh ENOENT",
    ...POSIX_SHELL,
  },
  {
    file: "test/agents.test.mjs",
    test: "exactly one copy of the gate checks each push, whatever hook files and plugins are present",
    fails: "spawnSync /bin/sh ENOENT",
    ...POSIX_SHELL,
  },
  {
    file: "test/agents.test.mjs",
    test: "each session gets the always-on line, the gate's context and Codex's plugin-not-running note once each",
    fails: "spawnSync /bin/sh ENOENT",
    ...POSIX_SHELL,
  },
  {
    file: "test/agents.test.mjs",
    test: "in Cursor, an old repo gate in .claude/settings.json doesn't stop the plugin's check",
    fails: "spawnSync /bin/sh ENOENT",
    ...POSIX_SHELL,
  },
  {
    file: "test/agents.test.mjs",
    test: "a claim goes stale after two minutes: a session that starts again later under the same id gets the always-on line",
    fails: 'The "path" argument must be of type string. Received undefined',
    ...TMPDIR_ONLY,
  },
  {
    file: "test/ci.test.mjs",
    test: "the workflow runs the base branch's gate, not the PR's",
    fails: "0 !== 1",
    ...MSYS_PATHS,
  },
  {
    file: "test/consistency.test.mjs",
    test: "the README's 'try it' script makes a gated repo where an unchecked push is blocked",
    fails: "Cannot read properties of undefined (reading 'trim')",
    ...CRLF_CHECKOUT,
  },
  {
    file: "test/consistency.test.mjs",
    test: "without node, the Cursor plugin's hooks fail open",
    fails: "undefined !== ''",
    ...POSIX_SHELL,
  },
  {
    file: "test/consistency.test.mjs",
    test: "without node, the Codex plugin's hooks fail open",
    fails: "undefined !== ''",
    ...POSIX_SHELL,
  },
  {
    file: "test/consistency.test.mjs",
    test: "the Antigravity plugin's rule is the always-on instruction, without the words that say the hooks ran",
    fails: 'dialect.\\r\\n"',
    ...CRLF_CHECKOUT,
  },
  {
    file: "test/e2e-tools.test.mjs",
    test: "the gate log records a gate.mjs run: which copy, its arguments, folder, exit code and output",
    fails: "RUNNER~1",
    ...SHORT_PATH,
  },
  {
    file: "test/fingerprints.test.mjs",
    test: "thousands of files and a name starting with a colon are handled",
    fails: ":weird.js",
    ...NTFS_NAME,
  },
  {
    file: "test/fingerprints.test.mjs",
    test: "only plain markdown at the reserved .learning/ paths is exempt",
    fails: "'.learning/checks/run.md'",
    ...FILE_MODE,
  },
  {
    file: "test/fingerprints.test.mjs",
    test: "report.local.json is never part of the change; nothing else is exempt",
    fails: "'.learning/report.local.json'",
    ...FILE_MODE,
  },
  {
    file: "test/fingerprints.test.mjs",
    test: "user git config and env don't change fingerprints",
    fails: "Not inside a git working tree",
    ...NUL_CONFIG,
  },
  {
    file: "test/fingerprints.test.mjs",
    test: "a file mode change is compared three-way",
    fails: "nothing to commit",
    ...FILE_MODE,
  },
  {
    file: "test/fingerprints.test.mjs",
    test: "a merge from main can't smuggle in extra edits",
    fails: "[]",
    ...CRLF_EDIT,
  },
  {
    file: "test/hooks.test.mjs",
    test: WHOLE_FILE,
    fails: "Cannot read properties of undefined (reading 'trim')",
    ...issue10(
      "Looks git up through /bin/sh while the file loads (const GIT), which Node on Windows can't find, so none of its tests run (section 1).",
    ),
  },
  ...[
    "protect dry run changes nothing",
    "protect apply creates the ruleset",
    "protect says why it couldn't create the ruleset [exists-already exists]",
    "protect says why it couldn't create the ruleset [forbidden-admin]",
    "protect says why it couldn't create the ruleset [free-private-free plan]",
  ].map((test) => ({ file: "test/install.test.mjs", test, fails: "gh repo view failed", ...FAKE_GH })),
  {
    file: "test/install.test.mjs",
    test: "protect without the GitHub CLI says it's needed",
    fails: "git not found on PATH",
    ...GIT_EXE,
  },
  {
    file: "test/security.test.mjs",
    test: "a hostile config can't hang session start [fifo]",
    fails: "expected a GateError",
    ...MSYS_FIFO,
  },
];
