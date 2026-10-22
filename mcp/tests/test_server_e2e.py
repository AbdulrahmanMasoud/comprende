"""End-to-end: start the real server as a subprocess and talk MCP to it over
stdio, exactly like Claude Code or Claude Desktop would."""
import os
import sys

import anyio
import pytest

from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

EXPECTED_TOOLS = {
    "learning_context", "record_topic", "record_checkpoint", "set_preference",
    "progress_report", "search_decisions", "add_decision", "update_map",
    "gate_status", "save_check_report",
}


def text_of(result) -> str:
    return "".join(getattr(c, "text", "") for c in result.content)


async def _session_flow(home: str, repo: str):
    src = os.path.join(os.path.dirname(__file__), "..", "src")
    params = StdioServerParameters(
        command=sys.executable, args=["-m", "explain_mcp.server"],
        env={**os.environ, "EXPLAIN_HOME": home, "PYTHONPATH": os.path.abspath(src)},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            assert "learning_context" in (init.instructions or "")

            tools = {t.name: t for t in (await session.list_tools()).tools}
            assert set(tools) == EXPECTED_TOOLS
            assert tools["learning_context"].annotations.read_only_hint is True
            assert "Neutral evidence" in str(tools["record_topic"].input_schema)

            await session.call_tool("record_topic", {"topic": "asyncio", "event": "learning",
                                                     "note": "new to event loops", "repo_root": repo})
            await session.call_tool("add_decision", {
                "repo_root": repo, "title": "Semaphore for concurrency cap",
                "context": "too many sockets", "decision": "asyncio.Semaphore(10)",
                "alternatives": ["connector limit — hides intent"], "consequences": "none"})
            ctx = text_of(await session.call_tool("learning_context", {"repo_root": repo}))
            assert "asyncio" in ctx and "0001 — Semaphore for concurrency cap" in ctx

            bad = await session.call_tool("record_topic", {"topic": "x", "event": "learning",
                                                           "note": "token = ghp_" + "a" * 36})
            assert bad.is_error and "credential" in text_of(bad)

            invalid = await session.call_tool("record_topic", {"topic": "x", "event": "mastered"})
            assert invalid.is_error

            # Ownership gate through MCP, on a real git repo
            import subprocess
            def git(*a):
                subprocess.run(["git", *a], cwd=repo, check=True, capture_output=True,
                               env={**os.environ, "GIT_AUTHOR_NAME": "d", "GIT_AUTHOR_EMAIL": "d@x",
                                    "GIT_COMMITTER_NAME": "d", "GIT_COMMITTER_EMAIL": "d@x"})
            git("init", "-q", "-b", "main")
            with open(os.path.join(repo, "app.py"), "w") as f:
                f.write("x = 1\n")
            git("add", "app.py")
            git("commit", "-qm", "init")
            git("checkout", "-q", "-b", "feat")
            with open(os.path.join(repo, "app.py"), "w") as f:
                f.write("x = 2\n")
            st = text_of(await session.call_tool("gate_status", {"repo_root": repo}))
            assert "app.py [new]" in st
            short = await session.call_tool("save_check_report", {
                "repo_root": repo, "summary": "changed x", "verified": {"app.py": ["why x is 2"]}})
            assert short.is_error and "summary" in text_of(short)
            ok = await session.call_tool("save_check_report", {
                "repo_root": repo,
                "summary": "Bumped x to 2 because the downstream parser expects the v2 format; "
                           "anything still sending v1 will now be rejected.",
                "verified": {"app.py": ["why x is 2", "v1 callers break"]}})
            assert not ok.is_error, text_of(ok)
            assert os.path.exists(os.path.join(repo, ".learning", "checks", "feat.md"))


def test_full_session_over_stdio(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    anyio.run(_session_flow, str(tmp_path / "home"), str(repo))
