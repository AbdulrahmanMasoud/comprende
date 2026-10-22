"""Checks that only make sense in the plugin repo: the shipped copies agree
and the manifests point at files that exist."""
import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PLUGIN = REPO / ".claude-plugin" / "plugin.json"
pytestmark = pytest.mark.skipif(not PLUGIN.exists(), reason="not running inside the plugin repo")


def test_gate_copies_are_identical():
    shipped = REPO / "skills/explain-as-you-build/scripts/gate.py"
    source = REPO / "mcp/src/explain_mcp/gate.py"
    assert shipped.read_bytes() == source.read_bytes(), \
        "skills/.../scripts/gate.py must be an exact copy of mcp/src/explain_mcp/gate.py"


def test_manifests_and_hook_paths():
    plugin = json.loads(PLUGIN.read_text())
    market = json.loads((REPO / ".claude-plugin/marketplace.json").read_text())
    assert market["plugins"][0]["name"] == plugin["name"]
    hooks = json.loads((REPO / "hooks/hooks.json").read_text())["hooks"]
    commands = [h["command"] for groups in hooks.values() for g in groups for h in g["hooks"]]
    for c in commands:
        rel = c.split("${CLAUDE_PLUGIN_ROOT}/", 1)[1].split('"', 1)[0]
        assert (REPO / rel).is_file(), rel
    assert any("session-start" in c for c in commands)
    assert any("claude-hook --from-plugin" in c for c in commands)
    mcp = json.loads((REPO / ".mcp.json").read_text())["mcpServers"]["explain-as-you-build"]
    assert (REPO / "mcp/pyproject.toml").is_file() and (REPO / "mcp/README.md").is_file()
    assert mcp["args"][-1] == "explain-as-you-build-mcp"


def test_version_is_set_in_one_place():
    market = json.loads((REPO / ".claude-plugin/marketplace.json").read_text())
    assert "version" not in market["plugins"][0]
    assert json.loads(PLUGIN.read_text())["version"]
