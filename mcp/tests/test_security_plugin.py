"""Regression tests for the security review of the plugin layer. The threat:
a malicious repo the user clones and opens with the plugin installed."""
import json
import os
import subprocess
import sys
import time

import pytest

from explain_mcp import gate, server
from test_gate import ENV, payload, run_gate, setup, sh, write  # noqa: F401
from test_gate_review_findings import commit_all

PLUGIN_GATE = str(gate.__file__)


def plugin(cwd, *args, input="", env=None, timeout=60):
    return subprocess.run([sys.executable, PLUGIN_GATE, *args], cwd=cwd, input=input,
                          capture_output=True, text=True, env=env or ENV, timeout=timeout)


def session_start(dev, tmp_path, env=None):
    out = plugin(tmp_path, "session-start", input=json.dumps({"cwd": str(dev)}), env=env).stdout
    return json.loads(out).get("hookSpecificOutput", {}).get("additionalContext", "")


def push(dev):
    return sh(dev, "git", "push", "-u", "origin", "HEAD:refs/heads/feature/x", check=False)


# F1: a module planted next to gate.py must never be imported by the hook.
def test_planted_stdlib_module_never_runs_on_push(setup, tmp_path):
    dev = setup["dev"]
    marker = tmp_path / "PWNED-1"
    for mod in ("json", "hashlib", "argparse", "subprocess"):
        write(dev, f".learning/{mod}.py", f"open({str(marker)!r}, 'w').write('x')\n")
        write(dev, f"{mod}.py", f"open({str(marker)!r}, 'w').write('x')\n")
    write(dev, "src/app.js", "export const app = 2;\n")
    commit_all(dev, "plant modules")
    (dev / ".git/hooks/pre-push").unlink()
    session_start(dev, tmp_path)                                    # auto-installs the pinned hook
    r = push(dev)
    assert not marker.exists()
    assert r.returncode != 0 and "No ownership report" in r.stderr  # the gate itself still worked


# F2: gate.py swapped after the hook was installed is not executed.
def test_gate_swapped_after_install_is_not_executed(setup, tmp_path):
    dev = setup["dev"]
    marker = tmp_path / "PWNED-2"
    (dev / ".learning/gate.py").write_text(f"open({str(marker)!r}, 'w').write('x')\n")
    write(dev, "src/app.js", "export const app = 2;\n")
    commit_all(dev, "swap the gate")
    r = push(dev)
    assert not marker.exists()
    assert "changed since this hook was installed" in r.stderr
    # explicitly re-trusting re-pins (the user's decision, not automatic)
    assert "SKIPPED" not in gate.install_hooks(str(dev))[0]


def test_session_start_repins_only_for_trusted_code(setup, tmp_path):
    dev = setup["dev"]
    hook = dev / ".git/hooks/pre-push"
    before = hook.read_text()
    (dev / ".learning/gate.py").write_text("print('different')\n")
    assert "NOT installed automatically" in session_start(dev, tmp_path)
    assert hook.read_text() == before                               # still pinned to the trusted copy


# F3: a global/shared core.hooksPath is never written to automatically.
def test_shared_hooks_path_is_never_touched(setup, tmp_path):
    dev = setup["dev"]
    shared = tmp_path / "global-hooks"
    shared.mkdir()
    sh(dev, "git", "config", "core.hooksPath", str(shared))
    ctx = session_start(dev, tmp_path)
    assert not (shared / "pre-push").exists() and "core.hooksPath is set" in ctx
    out = gate.install_hooks(str(dev))[0]                           # explicit, but shared dir: refuse
    assert out.startswith("SKIPPED") and "outside this repo" in out and not (shared / "pre-push").exists()
    sh(dev, "git", "config", "core.hooksPath", ".husky")             # repo-local custom dir: allowed explicitly
    assert gate.install_hooks(str(dev))[0].startswith("installed") and (dev / ".husky/pre-push").exists()


# F4: hostile config files can't hang or exhaust a session.
@pytest.mark.parametrize("kind", ["devzero", "huge", "fifo"])
def test_hostile_config_cannot_hang_session_start(setup, tmp_path, kind):
    dev = setup["dev"]
    cfg = dev / ".learning/config.json"
    cfg.unlink()
    if kind == "devzero":
        os.symlink("/dev/zero", cfg)
    elif kind == "huge":
        cfg.write_text('{"ownership_check": {"mode": "required", "x": "' + "a" * 2_000_000 + '"}}')
    else:
        os.mkfifo(cfg)
    t = time.time()
    r = plugin(tmp_path, "session-start", input=json.dumps({"cwd": str(dev)}), timeout=20)
    assert r.returncode == 0 and json.loads(r.stdout) == {} and time.time() - t < 10
    with pytest.raises(gate.GateError):
        gate.status(str(dev))


def test_symlinked_report_and_settings_are_not_followed(setup, tmp_path):
    dev = setup["dev"]
    rel = dev / gate.report_relpath("feature/rate-limit")
    rel.parent.mkdir(parents=True, exist_ok=True)
    os.symlink("/dev/zero", rel)
    write(dev, "src/app.js", "export const app = 2;\n")
    st = gate.status(str(dev))                                       # lenient: notes it, doesn't read it
    assert any("symlink" in n for n in st["notes"])
    (dev / ".claude/settings.json").unlink()
    os.symlink("/dev/zero", dev / ".claude/settings.json")
    assert "SKIPPED" in gate._merge_claude_settings(dev / ".claude/settings.json")


# F5: commands from the repo's own .git/config never run while reading changes.
def test_repo_local_filter_commands_are_refused(setup, tmp_path):
    dev = setup["dev"]
    marker = tmp_path / "PWNED-5"
    sh(dev, "git", "config", "filter.evil.clean", f"sh -c 'touch {marker}; cat'")
    write(dev, ".gitattributes", "*.js filter=evil\n")
    write(dev, "src/app.js", "export const app = 2;\n")
    with pytest.raises(gate.GateError, match="filter commands"):
        gate.status(str(dev))
    with pytest.raises(Exception, match="filter commands"):
        server._gate_cli(str(dev), ["status"])
    assert not marker.exists()
    trusted = {**ENV, "OWNERSHIP_GATE_TRUST_REPO_CONFIG": "1"}
    assert run_gate(dev, "status", env=trusted).returncode == 0      # explicit trust: the user's own setup


def test_repo_local_fsmonitor_command_never_runs(setup, tmp_path):
    dev = setup["dev"]
    marker = tmp_path / "PWNED-fsmonitor"
    script = tmp_path / "fsm.sh"
    script.write_text(f"#!/bin/sh\ntouch {marker}\n")
    script.chmod(0o755)
    sh(dev, "git", "config", "core.fsmonitor", str(script))
    write(dev, "src/app.js", "export const app = 2;\n")
    gate.status(str(dev))
    assert not marker.exists()


def test_global_filters_like_lfs_still_work(setup, tmp_path):
    dev = setup["dev"]
    gcfg = tmp_path / "gitconfig"
    gcfg.write_text("[filter \"upper\"]\n\tclean = tr a-z A-Z\n\tsmudge = cat\n")
    env = {**ENV, "GIT_CONFIG_GLOBAL": str(gcfg)}
    write(dev, ".gitattributes", "*.txt filter=upper\n")
    write(dev, "notes.txt", "hello\n")
    r = run_gate(dev, "status", env=env)
    assert r.returncode == 0 and "notes.txt" in r.stdout


# F6: no links, images, HTML, code spans or table breaks from PR authors.
def test_job_summary_neutralises_author_markdown():
    s = gate._md_safe("[click](https://evil.example) ![i](x) <b>|x| `code` **bold**")
    for bad in ("[click](", "![i]", "<b>", "|x|", "`code`", "**bold**"):
        assert bad not in s
