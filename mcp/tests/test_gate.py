"""Gate tests against real git repositories: a bare "GitHub" remote, a
developer clone, real pushes through the installed pre-push hook, and a
fresh CI-style clone checked out at the PR head."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from explain_mcp import gate

GATE = Path(gate.__file__).resolve()
SUMMARY = ("Added a per-IP limit on the public routes so scrapers can't hammer the database; "
           "if Redis is down we let requests through, which is the main thing that could go wrong.")

ENV = {**os.environ, "GIT_AUTHOR_NAME": "Dev", "GIT_AUTHOR_EMAIL": "dev@example.com",
       "GIT_COMMITTER_NAME": "Dev", "GIT_COMMITTER_EMAIL": "dev@example.com"}
ENV.pop("GITHUB_HEAD_REF", None)
ENV.pop("GITHUB_ACTIONS", None)


def sh(cwd, *args, check=True, input=None, env=None):
    proc = subprocess.run(list(args), cwd=cwd, capture_output=True, text=True, input=input, env=env or ENV)
    if check and proc.returncode != 0:
        raise AssertionError(f"{args} failed:\n{proc.stdout}\n{proc.stderr}")
    return proc


def run_gate(cwd, *args, input=None, env=None):
    return sh(cwd, sys.executable, str(cwd / ".learning" / "gate.py"), *args,
              check=False, input=input, env=env)


def write(root, rel, text):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("GITHUB_HEAD_REF", raising=False)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    for k, v in ENV.items():
        if k.startswith("GIT_"):
            monkeypatch.setenv(k, v)


@pytest.fixture
def setup(tmp_path):
    remote = tmp_path / "remote.git"
    sh(tmp_path, "git", "init", "-q", "--bare", "-b", "main", str(remote))
    dev = tmp_path / "dev"
    sh(tmp_path, "git", "clone", "-q", str(remote), str(dev))
    sh(dev, "git", "checkout", "-q", "-b", "main")
    write(dev, "src/app.js", "export const app = 1;\n")
    write(dev, "src/auth/login.js", "export function login() {}\n")
    write(dev, "src/old.js", "old\n")
    write(dev, "package-lock.json", "{}\n")
    sh(dev, "git", "add", "-A")
    sh(dev, "git", "commit", "-qm", "init")
    sh(dev, "git", "push", "-q", "-u", "origin", "main")
    sh(dev, "git", "remote", "set-head", "origin", "main")
    out = gate.install(str(dev))
    sh(dev, "git", "add", "-A")
    sh(dev, "git", "commit", "-qm", "add ownership gate")
    sh(dev, "git", "push", "-q", "origin", "main")
    sh(dev, "git", "checkout", "-q", "-b", "feature/rate-limit")
    return {"dev": dev, "remote": remote, "tmp": tmp_path, "install_output": out}


def payload(**verified):
    return {"summary": SUMMARY, "verified": verified or {"src/app.js": ["limit math"]}}


# ------------------------------------------------------------- install

def test_install_writes_everything_and_is_idempotent(setup):
    dev = setup["dev"]
    for rel in (".learning/gate.py", ".learning/config.json", ".github/workflows/ownership-check.yml",
                ".claude/settings.json"):
        assert (dev / rel).exists(), rel
    hook = dev / ".git" / "hooks" / "pre-push"
    assert os.access(hook, os.X_OK)
    cfg = json.loads((dev / ".learning/config.json").read_text())["ownership_check"]
    assert cfg["base"] == "main" and cfg["mode"] == "required"
    assert any("MANUAL STEP" in line for line in setup["install_output"])

    again = gate.install(str(dev))
    assert any("up to date" in l for l in again)
    assert any("already present" in l for l in again)
    assert any("already installed" in l for l in again)
    settings = json.loads((dev / ".claude/settings.json").read_text())
    assert len(settings["hooks"]["PreToolUse"]) == 1


def test_install_merges_existing_claude_settings_and_respects_foreign_hook(tmp_path):
    repo = tmp_path / "r"
    sh(tmp_path, "git", "init", "-q", "-b", "main", str(repo))
    write(repo, "a.txt", "a\n")
    sh(repo, "git", "add", "-A")
    sh(repo, "git", "commit", "-qm", "init")
    existing = {"permissions": {"allow": ["Bash(npm test)"]},
                "hooks": {"PreToolUse": [{"matcher": "Edit", "hooks": [{"type": "command", "command": "lint"}]}]}}
    write(repo, ".claude/settings.json", json.dumps(existing))
    write(repo, ".git/hooks/pre-push", "#!/bin/sh\necho mine\n")
    out = gate.install(str(repo))
    s = json.loads((repo / ".claude/settings.json").read_text())
    assert s["permissions"] == existing["permissions"]
    assert [g["matcher"] for g in s["hooks"]["PreToolUse"]] == ["Edit", "Bash"]
    assert any(l.startswith("SKIPPED pre-push") for l in out)
    assert (repo / ".git/hooks/pre-push").read_text() == "#!/bin/sh\necho mine\n"


def test_workflow_is_valid_yaml_with_expected_steps(setup):
    yaml = pytest.importorskip("yaml")
    wf = yaml.safe_load((setup["dev"] / ".github/workflows/ownership-check.yml").read_text())
    steps = wf["jobs"]["ownership"]["steps"]
    assert steps[0]["with"]["fetch-depth"] == 0
    assert "pull_request.head.sha" in steps[0]["with"]["ref"]
    assert 'gate.py" verify' in steps[-1]["run"]
    assert wf["permissions"] == {"contents": "read"}


# ------------------------------------------------------------- status / save / verify

def test_full_flow_save_commit_verify_then_stale_then_recheck(setup):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    write(dev, "src/util.js", "export const util = 1;\n")       # untracked new file
    write(dev, "package-lock.json", '{"x": 1}\n')                 # ignored by default

    st = gate.status(str(dev))
    assert {f["path"]: f["state"] for f in st["files"]} == {
        "package-lock.json": "new", "src/app.js": "new", "src/util.js": "new"}
    assert [f["path"] for f in st["files"] if f["ignored"]] == ["package-lock.json"]
    assert [f["path"] for f in st["files"] if f["untracked"]] == ["src/util.js"]

    with pytest.raises(gate.GateError, match="summary"):
        gate.save({"summary": "did stuff", "verified": {"src/app.js": ["x"]}}, str(dev))
    with pytest.raises(gate.GateError, match="Not part of this change"):
        gate.save({"summary": SUMMARY, "verified": {"src/nope.js": ["x"]}}, str(dev))
    with pytest.raises(gate.GateError, match="No verified files"):
        gate.save({"summary": SUMMARY, "verified": {}}, str(dev))

    msg = gate.save(payload(**{"src/app.js": ["limit math"], "./src/util.js": "helper"}), str(dev))
    assert ".learning/checks/feature%2Frate-limit.md" in msg

    assert gate.verify(str(dev))[0]          # verify judges commits; nothing committed yet

    sh(dev, "git", "add", "src", "package-lock.json")
    sh(dev, "git", "commit", "-qm", "rate limit (report forgotten)")
    passed, problems, _ = gate.verify(str(dev))
    assert not passed and "No ownership report" in problems[0]

    sh(dev, "git", "add", "-A")
    sh(dev, "git", "commit", "-qm", "add report")
    assert gate.verify(str(dev))[0]

    # Code changes after the check -> stale
    write(dev, "src/app.js", "export const app = 3;\n")
    sh(dev, "git", "commit", "-qam", "tweak")
    passed, problems, _ = gate.verify(str(dev))
    assert not passed and "src/app.js" in problems[0] and "differs from what was verified" in problems[0]
    st = {f["path"]: f["state"] for f in gate.status(str(dev))["files"]}
    assert st == {"package-lock.json": "ok", "src/app.js": "stale", "src/util.js": "ok"}

    with pytest.raises(gate.GateError, match="src/app.js"):
        gate.save(payload(**{"src/util.js": ["helper"]}), str(dev))
    gate.save(payload(**{"src/app.js": ["new limit value"]}), str(dev))
    sh(dev, "git", "commit", "-qam", "recheck")
    assert gate.verify(str(dev))[0]

    report = gate.read_report(dev, "feature/rate-limit", rev="HEAD")
    assert report["verified"] == {"src/app.js": ["new limit value"], "src/util.js": ["helper"]}
    text = (dev / ".learning/checks/feature%2Frate-limit.md").read_text()
    assert "## Verified understanding" in text and SUMMARY in text


def test_sensitive_file_must_be_verified(setup):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    write(dev, "src/auth/login.js", "export function login(u) { return u; }\n")
    with pytest.raises(gate.GateError, match="src/auth/login.js"):
        gate.save(payload(), str(dev))
    assert any(f["sensitive"] for f in gate.status(str(dev))["files"])
    gate.save(payload(**{"src/app.js": ["x"], "src/auth/login.js": ["token check"]}), str(dev))
    sh(dev, "git", "add", "-A")
    sh(dev, "git", "commit", "-qm", "auth")
    assert gate.verify(str(dev))[0]


def test_deleted_file_and_only_ignored_changes(setup):
    dev = setup["dev"]
    write(dev, "package-lock.json", '{"only": "lock"}\n')
    st = gate.status(str(dev))
    assert [f["ignored"] for f in st["files"]] == [True] and st["must_verify"] == []
    sh(dev, "git", "commit", "-qam", "lockfile only")
    assert gate.verify(str(dev))[0]        # ignored-only change: no report needed (e.g. dependency bots)
    (dev / "src/old.js").unlink()
    gate.save(payload(**{"src/old.js": ["why it was safe to remove"]}), str(dev))
    sh(dev, "git", "add", "-A")
    sh(dev, "git", "commit", "-qm", "remove old")
    assert gate.verify(str(dev))[0]
    assert "src/old.js" in gate.read_report(dev, "feature/rate-limit", "HEAD")["files"]


def test_tampered_or_broken_report_fails(setup):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    gate.save(payload(), str(dev))
    sh(dev, "git", "add", "-A")
    sh(dev, "git", "commit", "-qm", "x")
    rel = dev / ".learning/checks/feature%2Frate-limit.md"
    data = gate.parse_report(rel.read_text())
    data["files"]["src/app.js"] = "0" * 40
    rel.write_text(gate.render_report(data))
    sh(dev, "git", "commit", "-qam", "forge")
    assert not gate.verify(str(dev))[0]
    rel.write_text("# just some text\n")
    sh(dev, "git", "commit", "-qam", "broken")
    with pytest.raises(gate.GateError, match="data block"):
        gate.verify(str(dev))


def _set_mode(root, mode):
    cfg_path = root / ".learning/config.json"
    cfg = json.loads(cfg_path.read_text())
    cfg["ownership_check"]["mode"] = mode
    cfg_path.write_text(json.dumps(cfg))


def test_a_pr_cannot_switch_its_own_check_off(setup):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    _set_mode(dev, "off")
    sh(dev, "git", "commit", "-qam", "turn it off in the PR")
    passed, problems, mode = gate.verify(str(dev))
    assert not passed and mode == "required" and "No ownership report" in problems[0]
    assert run_gate(dev, "verify").returncode == 1


def test_modes_come_from_the_base_branch(setup):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    sh(dev, "git", "commit", "-qam", "no report")

    sh(dev, "git", "checkout", "-q", "main")
    _set_mode(dev, "suggested")
    sh(dev, "git", "commit", "-qam", "team switches to suggested")
    sh(dev, "git", "push", "-q", "origin", "main")       # pushing the base itself isn't gated
    sh(dev, "git", "checkout", "-q", "feature/rate-limit")
    r = run_gate(dev, "verify")
    assert r.returncode == 0 and "No ownership report" in r.stderr   # warns, doesn't block

    sh(dev, "git", "checkout", "-q", "main")
    _set_mode(dev, "off")
    sh(dev, "git", "commit", "-qam", "team switches off")
    sh(dev, "git", "push", "-q", "origin", "main")
    sh(dev, "git", "checkout", "-q", "feature/rate-limit")
    assert gate.verify(str(dev)) == (True, [], "off")


def test_installing_the_gate_needs_no_report(tmp_path):
    remote = tmp_path / "remote.git"
    sh(tmp_path, "git", "init", "-q", "--bare", "-b", "main", str(remote))
    repo = tmp_path / "r"
    sh(tmp_path, "git", "clone", "-q", str(remote), str(repo))
    sh(repo, "git", "checkout", "-q", "-b", "main")
    write(repo, "src/a.js", "a\n")
    sh(repo, "git", "add", "-A")
    sh(repo, "git", "commit", "-qm", "init")
    sh(repo, "git", "push", "-q", "-u", "origin", "main")
    sh(repo, "git", "checkout", "-q", "-b", "chore/add-gate")
    gate.install(str(repo))
    sh(repo, "git", "add", "-A")
    sh(repo, "git", "commit", "-qm", "add gate")
    assert gate.verify(str(repo)) == (True, [], "required")
    assert sh(repo, "git", "push", "-u", "origin", "chore/add-gate", check=False).returncode == 0


# ------------------------------------------------------------- hooks

def test_real_push_blocked_then_allowed_by_pre_push_hook(setup):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    sh(dev, "git", "commit", "-qam", "unchecked change")
    blocked = sh(dev, "git", "push", "-u", "origin", "feature/rate-limit", check=False)
    assert blocked.returncode != 0
    assert "Ownership gate blocked" in blocked.stderr and "No ownership report" in blocked.stderr

    gate.save(payload(), str(dev))
    sh(dev, "git", "add", "-A")
    sh(dev, "git", "commit", "-qm", "ownership report")
    ok = sh(dev, "git", "push", "-u", "origin", "feature/rate-limit", check=False)
    assert ok.returncode == 0, ok.stderr


def test_pushing_another_branch_checks_that_branch_not_head(setup):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    sh(dev, "git", "commit", "-qam", "unchecked")
    sh(dev, "git", "checkout", "-q", "main")
    r = sh(dev, "git", "push", "origin", "feature/rate-limit", check=False)
    assert r.returncode != 0 and "feature/rate-limit" in r.stderr


@pytest.mark.parametrize("cmd,expected", [
    ("git push", True),
    ("git push -u origin feature/x", True),
    ("git -C /repo push", True),
    ("git add -A && git commit -m 'x' && git push", True),
    ("GIT_TRACE=1 git push --force-with-lease", True),
    ("/usr/bin/git push", True),
    ("gh pr create --fill", True),
    ("gh pr merge 12", True),
    ("git stash push -m wip", False),
    ("echo 'git push'", False),
    ("git status", False),
    ("gh pr view", False),
    ("npm run push", False),
])
def test_is_push_command(cmd, expected):
    assert gate.is_push_command(cmd) is expected


def test_claude_hook_blocks_only_pushes_without_report(setup):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    sh(dev, "git", "commit", "-qam", "unchecked")

    def hook(command, cwd=dev):
        return run_gate(dev, "claude-hook", input=json.dumps(
            {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": str(cwd)}))

    assert hook("npm test").returncode == 0
    r = hook("git push")
    assert r.returncode == 2 and "Blocked by the ownership gate" in r.stderr
    assert run_gate(dev, "claude-hook", input="not json").returncode == 0      # fail open
    assert hook("git push", cwd="/").returncode == 0                            # not a repo: fail open

    gate.save(payload(), str(dev))
    sh(dev, "git", "add", "-A")
    sh(dev, "git", "commit", "-qm", "report")
    assert hook("git push").returncode == 0


# ------------------------------------------------------------- CI

def test_ci_on_fresh_clone_at_pr_head_even_after_main_moves(setup):
    dev, tmp = setup["dev"], setup["tmp"]
    write(dev, "src/app.js", "export const app = 2;\n")
    gate.save(payload(), str(dev))
    sh(dev, "git", "add", "-A")
    sh(dev, "git", "commit", "-qm", "feature + report")
    sh(dev, "git", "push", "-q", "-u", "origin", "feature/rate-limit")
    head_sha = sh(dev, "git", "rev-parse", "HEAD").stdout.strip()

    # Someone else lands a change on main touching the same file
    other = tmp / "other"
    sh(tmp, "git", "clone", "-q", str(setup["remote"]), str(other))
    write(other, "src/app.js", "export const app = 1;\nexport const other = true;\n")
    sh(other, "git", "commit", "-qam", "main moves on")
    sh(other, "git", "push", "-q", "origin", "main")

    # CI: full clone, detached at the PR head, like actions/checkout with ref + fetch-depth 0
    ci = tmp / "ci"
    sh(tmp, "git", "clone", "-q", str(setup["remote"]), str(ci))
    sh(ci, "git", "checkout", "-q", "--detach", head_sha)
    ci_env = {**ENV, "GITHUB_ACTIONS": "true"}
    r = run_gate(ci, "verify", "--base", "origin/main", "--branch", "feature/rate-limit", env=ci_env)
    assert r.returncode == 0, r.stdout + r.stderr

    # A PR without a report fails with a GitHub annotation
    sh(dev, "git", "checkout", "-q", "-b", "feature/no-report", "main")
    write(dev, "src/app.js", "export const app = 9;\n")
    sh(dev, "git", "commit", "-qam", "no report")
    sh(dev, "git", "push", "-q", "--no-verify", "-u", "origin", "feature/no-report")
    sh(ci, "git", "fetch", "-q", "origin")
    sh(ci, "git", "checkout", "-q", "--detach", "origin/feature/no-report")
    r = run_gate(ci, "verify", "--base", "origin/main", "--branch", "feature/no-report", env=ci_env)
    assert r.returncode == 1 and "::error title=Ownership check::" in r.stdout


def test_workflow_script_runs_the_base_branch_gate_not_the_prs(setup):
    """Execute the workflow's actual shell step. A PR that replaces gate.py
    with a stub that always passes must still be checked by the real gate."""
    yaml = pytest.importorskip("yaml")
    dev, tmp = setup["dev"], setup["tmp"]
    wf = yaml.safe_load((dev / ".github/workflows/ownership-check.yml").read_text())
    script = wf["jobs"]["ownership"]["steps"][-1]["run"]

    write(dev, "src/app.js", "export const app = 2;\n")
    write(dev, ".learning/gate.py", "import sys\nprint('all good!')\nsys.exit(0)\n")
    sh(dev, "git", "commit", "-qam", "sneaky")
    sh(dev, "git", "push", "-q", "--no-verify", "-u", "origin", "feature/rate-limit")

    ci = tmp / "ci"
    sh(tmp, "git", "clone", "-q", str(setup["remote"]), str(ci))
    sh(ci, "git", "checkout", "-q", "--detach", "origin/feature/rate-limit")
    runner_temp = tmp / "runner"
    runner_temp.mkdir()
    env = {**ENV, "BASE_REF": "main", "HEAD_REF": "feature/rate-limit",
           "RUNNER_TEMP": str(runner_temp), "GITHUB_ACTIONS": "true"}
    r = sh(ci, "bash", "-e", "-c", script, check=False, env=env)
    assert r.returncode == 1, r.stdout + r.stderr
    assert "all good!" not in r.stdout and "No ownership report" in r.stdout + r.stderr


def test_shallow_clone_gives_actionable_error(setup):
    dev, tmp = setup["dev"], setup["tmp"]
    write(dev, "src/app.js", "export const app = 2;\n")
    sh(dev, "git", "commit", "-qam", "x")
    sh(dev, "git", "push", "-q", "--no-verify", "-u", "origin", "feature/rate-limit")
    shallow = tmp / "shallow"
    sh(tmp, "git", "clone", "-q", "--depth", "1", "--branch", "feature/rate-limit",
       f"file://{setup['remote']}", str(shallow))
    r = run_gate(shallow, "verify", "--base", "origin/main", "--branch", "feature/rate-limit")
    assert r.returncode == 1 and "fetch-depth: 0" in r.stderr
