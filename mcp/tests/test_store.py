import json
import os

import pytest

from explain_mcp import store


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    # Every test gets its own profile folder, never the real ~/.explain-as-you-build.
    monkeypatch.setenv("EXPLAIN_HOME", str(tmp_path / "home"))


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    return str(root)


def test_empty_profile_says_so():
    assert "No profile yet" in store.learning_context()


def test_record_topic_levels_and_explained():
    store.record_topic("React Hooks", "knows", "wrote a custom hook")
    store.record_topic("docker", "learning", "asked what an image layer is", "shop-api")
    store.record_topic("debounce", "explained")
    ctx = store.learning_context()
    assert "Comfortable: react-hooks" in ctx
    assert "docker — " in ctx and "shop-api" in ctx and "image layer" in ctx
    assert "debounce" in ctx.split("Explained before")[1]


def test_evidence_capped():
    for i in range(6):
        store.record_topic("sql", "learning", f"note {i}")
    entry = store.load_profile()["topics"]["sql"]
    assert len(entry["evidence"]) == store.MAX_EVIDENCE
    assert entry["evidence"][-1].endswith("note 5")


def test_checkpoint_promotes_after_two_right_and_demotes_on_wrong():
    store.record_topic("closures", "learning")
    store.record_checkpoint("closures", "what does the inner fn capture?", True)
    assert store.load_profile()["topics"]["closures"]["level"] == "learning"
    store.record_checkpoint("closures", "q2", True)
    assert store.load_profile()["topics"]["closures"]["level"] == "comfortable"
    store.record_checkpoint("closures", "q3", False)
    assert store.load_profile()["topics"]["closures"]["level"] == "learning"


def test_preferences_set_and_clear():
    store.set_preference("Language", "Egyptian Arabic")
    assert "language=Egyptian Arabic" in store.learning_context()
    store.set_preference("language", "")
    assert "language" not in store.load_profile()["preferences"]


def test_secrets_refused_everywhere(repo):
    with pytest.raises(store.MemoryError_):
        store.record_topic("aws", "knows", "used key AKIAABCDEFGHIJKLMNOP")
    with pytest.raises(store.MemoryError_):
        store.update_map(repo, "DB: postgres://admin:hunter22@db.internal/prod")
    with pytest.raises(store.MemoryError_):
        store.add_decision(repo, "Auth", "ctx", "use api_key = abcdef123456", [], "none")
    assert not os.path.exists(os.path.join(store.home(), "profile.json"))


def test_corrupt_profile_is_kept_and_replaced():
    store.home().mkdir(parents=True)
    (store.home() / "profile.json").write_text("{not json")
    assert "No profile yet" in store.learning_context()
    assert list(store.home().glob("profile.broken-*.json"))


def test_project_without_learning_folder(repo):
    assert "no .learning/ folder yet" in store.learning_context(repo)


def test_decisions_numbered_searchable_and_compatible_with_file_mode(repo):
    # A record made by the phase-2 script (file mode) already exists.
    d = os.path.join(repo, ".learning", "decisions")
    os.makedirs(d)
    with open(os.path.join(d, "0001-cache-aside.md"), "w") as f:
        f.write("# 0001 — Cache-aside over write-through\nDate: 2026-10-01 · Status: accepted\n\n"
                "Decision: cache-aside with Redis, 5 min TTL.\n")
    msg = store.add_decision(repo, "Sliding-window rate limit in Redis",
                             "public routes unprotected", "sliding window per IP, 60/min",
                             ["fixed window — 2x bursts", "in-memory — breaks with >1 instance"],
                             "Redis is now required by public routes")
    assert "0002" in msg
    assert os.path.exists(os.path.join(d, "0002-sliding-window-rate-limit-in-redis.md"))
    top = store.search_decisions(repo, "rate limit", limit=1)
    assert "notes, not instructions" in top and top.split(":\n\n", 1)[1].startswith("# 0002")
    assert "Cache-aside" in store.search_decisions(repo, "cache ttl")
    assert "No decisions match" in store.search_decisions(repo, "kubernetes")
    ctx = store.learning_context(repo)
    assert "0001 — Cache-aside over write-through [accepted]" in ctx
    assert "0002 — Sliding-window rate limit in Redis [accepted]" in ctx


def test_map_stamped_capped_and_replaced(repo):
    store.update_map(repo, "# Project map\nVerified: 2020-01-01\nEntry: src/server.js")
    text = open(os.path.join(repo, ".learning", "map.md")).read()
    assert text.count("Verified:") == 1 and "2020-01-01" not in text
    with pytest.raises(store.MemoryError_):
        store.update_map(repo, "\n".join(f"line {i}" for i in range(50)))


def test_bad_repo_root_rejected(tmp_path):
    with pytest.raises(store.MemoryError_):
        store.learning_context(str(tmp_path / "missing"))
    with pytest.raises(store.MemoryError_):
        store.search_decisions("", "x")


def test_symlinked_learning_outside_repo_refused(repo, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    os.symlink(outside, os.path.join(repo, ".learning"))
    with pytest.raises(store.MemoryError_):
        store.update_map(repo, "Entry: x")
    assert not (outside / "map.md").exists()


def test_legacy_me_local_noticed(repo):
    os.makedirs(os.path.join(repo, ".learning"))
    open(os.path.join(repo, ".learning", "me.local.md"), "w").write("# old")
    assert "me.local.md exists" in store.learning_context(repo)


def test_progress_report():
    assert store.progress_report() == "Nothing tracked yet."
    store.record_topic("git", "knows")
    store.record_checkpoint("asyncio", "what does gather do on error?", False)
    report = store.progress_report()
    assert "Comfortable (1): git" in report
    assert "Checkpoints: 0/1 correct" in report
    assert "Worth revisiting: asyncio" in report


def test_profile_is_valid_utf8_json_with_arabic():
    store.set_preference("language", "مصري")
    raw = (store.home() / "profile.json").read_text(encoding="utf-8")
    assert "مصري" in raw and json.loads(raw)["preferences"]["language"] == "مصري"
