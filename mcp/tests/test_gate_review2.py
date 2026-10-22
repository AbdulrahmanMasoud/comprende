"""Regression tests for the second independent review."""
import json
import os
import subprocess
import sys
import time

import pytest

from explain_mcp import gate
from test_gate import ENV, SUMMARY, payload, run_gate, setup, sh, write  # noqa: F401
from test_gate_review_findings import commit_all, save_and_commit


def ci_verify(setup, branch="feature/rate-limit", env_extra=None):
    """Push, then verify from a fresh clone with no user config — like CI."""
    dev, tmp = setup["dev"], setup["tmp"]
    sh(dev, "git", "push", "-q", "-f", "--no-verify", "origin", f"HEAD:refs/heads/{branch}")
    ci = tmp / f"ci-{time.time_ns()}"
    sh(tmp, "git", "clone", "-q", str(setup["remote"]), str(ci))
    sh(ci, "git", "checkout", "-q", "--detach", f"origin/{branch}")
    env = {k: v for k, v in ENV.items() if k not in ("GIT_CONFIG_GLOBAL",)}
    env.update({"GIT_CONFIG_GLOBAL": os.devnull, **(env_extra or {})})
    return run_gate(ci, "verify", "--base", "origin/main", "--branch", branch, env=env)


# 1. Moving an identical edit to another place in the file is a different change.
def test_moving_an_edit_between_identical_blocks_is_stale(setup):
    dev = setup["dev"]
    block = "  role: user\n  mfa: true\n  limits: default\n"
    base = f"bot:\n{block}admin:\n{block}"
    sh(dev, "git", "checkout", "-q", "main")
    write(dev, "config/users.yml", base)
    commit_all(dev, "users")
    sh(dev, "git", "push", "-q", "origin", "main")
    sh(dev, "git", "checkout", "-q", "-B", "feature/rate-limit")
    write(dev, "config/users.yml", base.replace("bot:\n  role: user\n  mfa: true", "bot:\n  role: user\n  mfa: false", 1))
    save_and_commit(dev, **{"config/users.yml": ["MFA off for the test bot"]})
    assert gate.verify(str(dev))[0]
    moved = base.replace("admin:\n  role: user\n  mfa: true", "admin:\n  role: user\n  mfa: false")
    write(dev, "config/users.yml", moved)
    commit_all(dev, "move the edit to admin")
    passed, problems, _ = gate.verify(str(dev))
    assert not passed and "config/users.yml" in problems[0]


# 2. Ignored files are still tracked; plumbing patterns are exact.
def test_ignored_files_are_tracked_after_report_and_plumbing_is_narrow(setup):
    dev = setup["dev"]
    write(dev, "src/app.js", "require('./x');\n")
    write(dev, "package-lock.json", '{"resolved": "https://registry.npmjs.org/x.tgz"}\n')
    save_and_commit(dev)
    assert gate.verify(str(dev))[0]
    write(dev, "package-lock.json", '{"resolved": "https://evil.example/x.tgz"}\n')
    commit_all(dev, "swap tarball")
    passed, problems, _ = gate.verify(str(dev))
    assert not passed and "package-lock.json" in problems[0]

    for sneaky in (".learning/checks/helper.js", ".learning/checks/sub/x.md", ".learning/decisions/run.sh"):
        assert not gate.is_plumbing(sneaky), sneaky
    for real in (".learning/checks/feature%2Fx.md", ".learning/decisions/0001-x.md", ".learning/map.md",
                 ".learning/me.local.md", ".github/CODEOWNERS"):
        assert gate.is_plumbing(real), real


# 3. The developer's git config, attributes and env can't make local and CI disagree.
def test_user_git_config_and_env_dont_change_fingerprints(setup, tmp_path):
    dev, tmp = setup["dev"], setup["tmp"]
    lib = tmp / "lib"
    sh(tmp, "git", "init", "-q", "-b", "main", str(lib))
    write(lib, "l.txt", "1\n")
    commit_all(lib, "l1")
    sh(dev, "git", "-c", "protocol.file.allow=always", "submodule", "add", "-q", str(lib), "vendor/lib")
    attrs = tmp_path / "attrs"
    attrs.write_text("*.py -diff\n*.txt diff=weird\n")
    for k, v in {"diff.suppressBlankEmpty": "true", "diff.submodule": "log", "core.bigFileThreshold": "1",
                 "core.attributesFile": str(attrs), "diff.weird.binary": "true", "diff.algorithm": "patience",
                 "color.ui": "always", "diff.noprefix": "true", "core.quotePath": "false",
                 "diff.relative": "true", "core.pager": "cat"}.items():
        sh(dev, "git", "config", k, v)
    write(dev, "src/big.py", "".join(f"x{i} = {i}\n\n" for i in range(2000)))
    write(dev, "notes.txt", "a\n\nb\n")
    env = {**ENV, "GIT_DIFF_OPTS": "--unified=1"}
    msg = run_gate(dev, "save", input=json.dumps(payload(**{"src/big.py": ["generated constants"],
                                                            "vendor/lib": ["why vendored"]})), env=env)
    assert msg.returncode == 0, msg.stderr
    commit_all(dev, "change under odd config")
    r = ci_verify(setup)
    assert r.returncode == 0, r.stdout + r.stderr


# 4. Installing with --owner (which writes CODEOWNERS) needs no report.
def test_install_with_owner_needs_no_report(tmp_path):
    remote = tmp_path / "remote.git"
    sh(tmp_path, "git", "init", "-q", "--bare", "-b", "main", str(remote))
    repo = tmp_path / "r"
    sh(tmp_path, "git", "clone", "-q", str(remote), str(repo))
    sh(repo, "git", "checkout", "-q", "-b", "main")
    write(repo, "src/a.js", "a\n")
    commit_all(repo, "init")
    sh(repo, "git", "push", "-q", "-u", "origin", "main")
    sh(repo, "git", "checkout", "-q", "-b", "chore/add-gate")
    gate.install(str(repo), owner="@acme/leads")
    commit_all(repo, "add gate")
    assert gate.verify(str(repo))[0]
    assert sh(repo, "git", "push", "-u", "origin", "chore/add-gate", check=False).returncode == 0


# 5. status/save use the base's rules, so a rule added on main after forking is honoured locally.
def test_status_uses_base_rules_added_after_fork(setup):
    dev = setup["dev"]
    write(dev, "src/billing/charge.js", "charge()\n")
    write(dev, "src/app.js", "export const app = 2;\n")
    sh(dev, "git", "stash", "-q", "-u")
    sh(dev, "git", "checkout", "-q", "main")
    cfg = json.loads((dev / ".learning/config.json").read_text())
    cfg["ownership_check"]["sensitive"].append("**/billing/**")
    (dev / ".learning/config.json").write_text(json.dumps(cfg))
    sh(dev, "git", "commit", "-qam", "billing is sensitive")
    sh(dev, "git", "push", "-q", "origin", "main")
    sh(dev, "git", "checkout", "-q", "feature/rate-limit")
    sh(dev, "git", "stash", "pop", "-q")
    assert gate.status(str(dev))["must_verify"] == ["src/billing/charge.js"]
    with pytest.raises(gate.GateError, match="billing"):
        gate.save(payload(**{"src/app.js": ["x"]}), str(dev))


# 6. An outdated or broken report doesn't block saving a new one.
@pytest.mark.parametrize("bad", ["# no data block\n", None])
def test_broken_or_old_report_can_be_replaced(setup, bad):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    rel = dev / gate.report_relpath("feature/rate-limit")
    if bad is None:  # a valid report from an older gate version
        gate.save(payload(), str(dev))
        text = rel.read_text().replace(f'"version": {gate.GATE_VERSION}', '"version": 1')
        rel.write_text(text)
    else:
        rel.parent.mkdir(parents=True, exist_ok=True)
        rel.write_text(bad)
    st = gate.status(str(dev))
    assert any("can't be used" in n for n in st["notes"])
    if bad is not None:
        assert st["must_verify"] == ["src/app.js"]      # unreadable report: not a clean slate
    gate.save(payload(), str(dev))
    commit_all(dev, "fresh report")
    assert gate.verify(str(dev))[0]


# 7. (Revised for public release.) The MCP server never executes the repo's own
#    gate.py — a cloned repo could ship anything there — and it says when versions differ.
def test_server_never_runs_repo_code_and_flags_version_skew(setup, tmp_path):
    from explain_mcp import server
    dev = setup["dev"]
    marker = tmp_path / "PWNED"
    (dev / ".learning/gate.py").write_text(f"GATE_VERSION = 1\nopen({str(marker)!r}, 'w').write('x')\n")
    write(dev, "src/app.js", "export const app = 2;\n")
    out = server._gate_cli(str(dev), ["status"])
    assert not marker.exists()
    assert "src/app.js [new]" in out and "is v1 but the running gate is" in out


# 8. Forks: upstream/<base> wins over the fork's own origin/<base>.
def test_upstream_base_preferred_in_forks(setup):
    dev, tmp = setup["dev"], setup["tmp"]
    upstream = tmp / "upstream.git"
    sh(tmp, "git", "clone", "-q", "--bare", str(setup["remote"]), str(upstream))
    sh(dev, "git", "remote", "add", "upstream", str(upstream))
    sh(dev, "git", "fetch", "-q", "upstream")
    assert gate.status(str(dev))["base"] == "upstream/main"


# 9. Performance: thousands of files in one pass.
def test_many_files_are_fast(setup):
    dev = setup["dev"]
    for i in range(3000):
        write(dev, f"gen/f{i:05d}.txt", f"{i}\n")
    t = time.time()
    gate.save(payload(**{"gen/f00000.txt": ["generator output"]}), str(dev))
    commit_all(dev, "lots")
    assert gate.verify(str(dev))[0]
    assert time.time() - t < 90          # generous: shared CI runners are slow; this guards against O(n) git calls


# 10. Hooks don't run on the throwaway index; untracked files are covered like any other.
def test_no_hooks_on_temp_index_and_untracked_counts(setup):
    dev = setup["dev"]
    hook = dev / ".git/hooks/post-index-change"
    marker = dev / "hook-ran"
    hook.write_text(f"#!/bin/sh\ntouch '{marker}'\n")
    hook.chmod(0o755)
    write(dev, "src/app.js", "export const app = 2;\n")
    gate.status(str(dev))
    assert not marker.exists()

    gate.save(payload(), str(dev))
    write(dev, "src/brand_new.js", "new code\n")                  # untracked, after the report
    assert gate.status(str(dev))["must_verify"] == ["src/brand_new.js"]


# 11. Unborn branch gets an accurate message.
def test_unborn_branch_message(tmp_path):
    repo = tmp_path / "r"
    sh(tmp_path, "git", "init", "-q", "-b", "main", str(repo))
    with pytest.raises(gate.GateError, match="no commits yet|base branch"):
        gate.status(str(repo))
