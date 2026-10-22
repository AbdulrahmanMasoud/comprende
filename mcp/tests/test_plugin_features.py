"""Plugin-era features: SessionStart auto-setup, the plugin's hook deferring to
the repo's gate, the CI job summary for reviewers, and `protect`."""
import json
import os
import sys
import textwrap

import pytest

from explain_mcp import gate
from test_gate import ENV, SUMMARY, payload, run_gate, setup, sh, write  # noqa: F401
from test_gate_review_findings import commit_all, save_and_commit

PLUGIN_GATE = str(gate.__file__)


def plugin(cwd, *args, input="", env=None):
    import subprocess
    return subprocess.run([sys.executable, PLUGIN_GATE, *args], cwd=cwd, input=input,
                          capture_output=True, text=True, env=env or ENV)


# ---------------------------------------------------------------- SessionStart

def test_session_start_installs_hook_once_and_adds_context(setup, tmp_path):
    dev = setup["dev"]
    hook = dev / ".git/hooks/pre-push"
    hook.unlink()
    ev = json.dumps({"hook_event_name": "SessionStart", "source": "startup", "cwd": str(dev)})
    out = json.loads(plugin(tmp_path, "session-start", input=ev).stdout)
    ctx = out["hookSpecificOutput"]["additionalContext"]
    assert out["hookSpecificOutput"]["hookEventName"] == "SessionStart"
    assert "ownership gate (mode: required)" in ctx and "just installed" in ctx
    assert hook.exists() and os.access(hook, os.X_OK)
    again = json.loads(plugin(tmp_path, "session-start", input=ev).stdout)
    assert "just installed" not in again["hookSpecificOutput"]["additionalContext"]


def test_session_start_respects_opt_out_foreign_hooks_and_quiet_repos(setup, tmp_path):
    dev = setup["dev"]
    (dev / ".git/hooks/pre-push").unlink()
    ev = json.dumps({"cwd": str(dev)})
    plugin(tmp_path, "session-start", input=ev, env={**ENV, "OWNERSHIP_GATE_NO_AUTO_HOOK": "1"})
    assert not (dev / ".git/hooks/pre-push").exists()

    (dev / ".git/hooks/pre-push").write_text("#!/bin/sh\necho mine\n")
    ctx = json.loads(plugin(tmp_path, "session-start", input=ev).stdout)["hookSpecificOutput"]["additionalContext"]
    assert "wasn't added" in ctx and "already exists" in ctx
    assert (dev / ".git/hooks/pre-push").read_text() == "#!/bin/sh\necho mine\n"

    plain = tmp_path / "plain"
    sh(tmp_path, "git", "init", "-q", "-b", "main", str(plain))
    for stdin in (json.dumps({"cwd": str(plain)}), json.dumps({"cwd": "/"}), "not json", ""):
        r = plugin(tmp_path, "session-start", input=stdin)
        assert r.returncode == 0 and json.loads(r.stdout) == {}


def test_session_start_silent_when_gate_is_off(setup, tmp_path):
    dev = setup["dev"]
    cfg = json.loads((dev / ".learning/config.json").read_text())
    cfg["ownership_check"]["mode"] = "off"
    (dev / ".learning/config.json").write_text(json.dumps(cfg))
    assert json.loads(plugin(tmp_path, "session-start", input=json.dumps({"cwd": str(dev)})).stdout) == {}


# ---------------------------------------------------------------- plugin PreToolUse hook

def push_event(cwd):
    return json.dumps({"tool_name": "Bash", "tool_input": {"command": "git push"}, "cwd": str(cwd)})


def test_plugin_hook_never_executes_repo_code(setup, tmp_path):
    dev = setup["dev"]
    (dev / ".claude/settings.json").unlink()           # repo without the project-level hook
    marker = tmp_path / "PWNED"
    (dev / ".learning/gate.py").write_text(f"open({str(marker)!r}, 'w').write('x')\n")
    write(dev, "src/app.js", "export const app = 2;\n")
    commit_all(dev, "unchecked + a malicious gate.py")
    r = plugin(tmp_path, "claude-hook", "--from-plugin", input=push_event(dev))
    assert not marker.exists()                         # the repo's code never ran
    assert r.returncode == 2 and "No ownership report" in r.stderr   # the plugin's own logic still blocks
    npm = json.dumps({"tool_name": "Bash", "tool_input": {"command": "npm test"}, "cwd": str(dev)})
    assert plugin(tmp_path, "claude-hook", "--from-plugin", input=npm).returncode == 0


def test_session_start_never_auto_installs_a_hook_for_unknown_gate_code(setup, tmp_path):
    dev = setup["dev"]
    (dev / ".git/hooks/pre-push").unlink()
    (dev / ".learning/gate.py").write_text("print('something else')\n")
    out = json.loads(plugin(tmp_path, "session-start", input=json.dumps({"cwd": str(dev)})).stdout)
    assert not (dev / ".git/hooks/pre-push").exists()
    assert "NOT installed automatically" in out["hookSpecificOutput"]["additionalContext"]


def test_plugin_hook_steps_aside_when_project_hook_exists(setup, tmp_path):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    commit_all(dev, "unchecked")
    # project settings already run the gate: the plugin copy must not double-run
    assert plugin(tmp_path, "claude-hook", "--from-plugin", input=push_event(dev)).returncode == 0
    assert run_gate(dev, "claude-hook", input=push_event(dev)).returncode == 2


def test_plugin_hook_falls_back_to_itself_without_a_repo_gate(setup, tmp_path):
    dev = setup["dev"]
    (dev / ".claude/settings.json").unlink()
    (dev / ".learning/gate.py").unlink()
    write(dev, "src/app.js", "export const app = 2;\n")
    commit_all(dev, "unchecked")
    r = plugin(tmp_path, "claude-hook", "--from-plugin", input=push_event(dev))
    assert r.returncode == 2 and "No ownership report" in r.stderr


# ---------------------------------------------------------------- CI job summary

def test_job_summary_for_reviewers(setup, tmp_path):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    write(dev, "src/auth/login.js", "export function login(u) { return u; }\n")
    gate.save({"summary": SUMMARY + " <script>alert(1)</script> ![x](https://evil.example/p.png)",
               "verified": {"src/app.js": ["limit math"], "src/auth/login.js": ["token check <b>"]}}, str(dev))
    commit_all(dev, "with report")
    summary_file = tmp_path / "summary.md"
    env = {**ENV, "GITHUB_ACTIONS": "true", "GITHUB_STEP_SUMMARY": str(summary_file)}
    r = run_gate(dev, "verify", env=env)
    assert r.returncode == 0
    md = summary_file.read_text()
    assert md.startswith("## ✅ Ownership check passed")
    assert "### The developer's summary" in md and "### Verified understanding" in md
    assert "| src/auth/login.js 🔒 | token check &lt;b&gt; |" in md
    assert "<script>" not in md and "&lt;script&gt;" in md and "![x]" not in md
    assert "never scores or mistakes" in md


def test_job_summary_on_failure(setup, tmp_path):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    commit_all(dev, "no report")
    summary_file = tmp_path / "summary.md"
    env = {**ENV, "GITHUB_ACTIONS": "true", "GITHUB_STEP_SUMMARY": str(summary_file)}
    assert run_gate(dev, "verify", env=env).returncode == 1
    md = summary_file.read_text()
    assert md.startswith("## ❌ Ownership check failed") and "No ownership report" in md


# ---------------------------------------------------------------- protect (with a fake gh)

FAKE_GH = """#!{python}
import json, os, sys
log = os.environ["FAKE_GH_LOG"]
mode = os.environ.get("FAKE_GH_MODE", "ok")
args = sys.argv[1:]
body = sys.stdin.read() if "--input" in args else ""
with open(log, "a") as f:
    f.write(json.dumps({{"args": args, "body": body}}) + "\\n")
if args[:2] == ["repo", "view"]:
    print("acme/shop-api"); sys.exit(0)
if args[:2] == ["api", "repos/acme/shop-api/rulesets"]:
    print(json.dumps([{{"id": 7, "name": "Ownership gate"}}] if mode == "exists" else [])); sys.exit(0)
if "-X" in args and "POST" in args:
    if mode == "forbidden":
        print("gh: Must have admin rights to Repository. (HTTP 403)", file=sys.stderr); sys.exit(1)
    if mode == "free-private":
        print("gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)",
              file=sys.stderr); sys.exit(1)
    print(json.dumps({{"id": 42}})); sys.exit(0)
sys.exit(1)
"""


@pytest.fixture
def fake_gh(tmp_path, monkeypatch):
    bindir = tmp_path / "fakebin"
    bindir.mkdir()
    gh = bindir / "gh"
    gh.write_text(FAKE_GH.format(python=sys.executable))
    gh.chmod(0o755)
    log = tmp_path / "gh.log"
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_GH_LOG", str(log))
    return lambda: [json.loads(l) for l in log.read_text().splitlines()] if log.exists() else []


def test_protect_dry_run_changes_nothing(setup, fake_gh):
    out = gate.protect(str(setup["dev"]))
    assert any("Dry run" in l for l in out)
    assert '"context": "Ownership check"' in out[-1] and "~DEFAULT_BRANCH" in out[-1]
    assert not any("POST" in c["args"] for c in fake_gh())


def test_protect_apply_creates_the_ruleset(setup, fake_gh):
    out = gate.protect(str(setup["dev"]), apply=True, approvals=2)
    assert out[-1] == "Created: https://github.com/acme/shop-api/rules/42"
    post = [c for c in fake_gh() if "POST" in c["args"]][0]
    body = json.loads(post["body"])
    assert post["args"][:4] == ["api", "-X", "POST", "repos/acme/shop-api/rulesets"]
    rules = {r["type"]: r["parameters"] for r in body["rules"]}
    assert rules["pull_request"]["required_approving_review_count"] == 2
    assert rules["pull_request"]["require_code_owner_review"] is True
    assert rules["required_status_checks"]["required_status_checks"] == [{"context": "Ownership check"}]


@pytest.mark.parametrize("mode,match", [("exists", "already exists"), ("forbidden", "admin"),
                                         ("free-private", "free plan")])
def test_protect_edge_cases(setup, fake_gh, monkeypatch, mode, match):
    monkeypatch.setenv("FAKE_GH_MODE", mode)
    if mode == "exists":
        assert match in gate.protect(str(setup["dev"]), apply=True)[0]
        assert not any("POST" in c["args"] for c in fake_gh())
    else:
        with pytest.raises(gate.GateError, match=match):
            gate.protect(str(setup["dev"]), apply=True)


def test_protect_without_gh(setup, monkeypatch, tmp_path):
    import shutil
    only_git = tmp_path / "only-git"
    only_git.mkdir()
    os.symlink(shutil.which("git"), only_git / "git")
    monkeypatch.setenv("PATH", str(only_git))
    with pytest.raises(gate.GateError, match="GitHub CLI"):
        gate.protect(str(setup["dev"]))


def test_workflow_job_name_matches_required_check():
    import yaml
    wf = yaml.safe_load(gate.WORKFLOW)
    assert wf["jobs"]["ownership"]["name"] == gate.CHECK_NAME
