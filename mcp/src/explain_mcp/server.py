"""MCP server for explain-as-you-build.

This file is deliberately thin: it only describes the tools to the model and
forwards calls to store.py. All the real logic lives there, which keeps it
testable without running a server.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from . import gate, store

INSTRUCTIONS = """\
Memory for explaining code while building it. It remembers what the user
already knows (across all their projects) and, per project, a short map and
the reasons behind lasting decisions.

- Call learning_context once at the start of a coding session, with the
  project's absolute path, before deciding how much to explain.
- Record evidence as you notice it (record_topic), not verdicts about ability.
- Record a decision only when a new teammate would ask "why is it like this?".
- Never store secrets; the tools refuse anything that looks like one.
"""

server = MCPServer("explain-as-you-build", instructions=INSTRUCTIONS)

READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=False)
WRITES = ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=False)

RepoRoot = Annotated[str, Field(description="Absolute path to the project's root folder.")]
Topic = Annotated[str, Field(description="Short concept name, e.g. 'react hooks', 'sql indexes', 'asyncio cancellation'.")]
Note = Annotated[str, Field(description="Neutral evidence, e.g. 'asked what an image layer is'. Not a judgment.")]


def _call(fn, *args, **kwargs) -> str:
    # Turn the store's refusals into tool errors the model can read and fix.
    try:
        return fn(*args, **kwargs)
    except (store.MemoryError_, gate.GateError) as e:
        raise ToolError(str(e)) from e


@server.tool(annotations=READ_ONLY)
def learning_context(repo_root: Annotated[str, Field(description="Absolute project path; empty for the profile only.")] = "") -> str:
    """Everything needed to calibrate explanations, in one call: the learner's
    known/learning/already-explained topics and preferences, plus this project's
    map and decision index. Call once at the start of a session."""
    return _call(store.learning_context, repo_root)


@server.tool(annotations=WRITES)
def record_topic(
    topic: Topic,
    event: Annotated[Literal["knows", "learning", "explained"], Field(
        description="knows = showed they understand it; learning = showed they're new to it; "
                    "explained = you just explained it (so don't repeat it later).")],
    note: Note = "",
    repo_root: Annotated[str, Field(description="Optional project path, kept as context for the note.")] = "",
) -> str:
    """Update what the learner knows about one topic. Applies across all their projects."""
    project = repo_root.rstrip("/").rsplit("/", 1)[-1] if repo_root else ""
    return _call(store.record_topic, topic, event, note, project)


@server.tool(annotations=WRITES)
def record_checkpoint(
    topic: Topic,
    question: Annotated[str, Field(description="The quick check you asked, in one line.")],
    correct: Annotated[bool, Field(description="Whether their answer showed understanding.")],
) -> str:
    """Log the result of a checkpoint question. Two correct in a row marks the
    topic comfortable; a wrong answer marks it learning."""
    return _call(store.record_checkpoint, topic, question, correct)


@server.tool(annotations=WRITES)
def set_preference(
    key: Annotated[str, Field(description="e.g. 'language', 'verbosity', 'analogies'.")],
    value: Annotated[str, Field(description="e.g. 'Egyptian Arabic', 'short'. Empty clears it.")],
) -> str:
    """Save something the user explicitly asked for about how to explain. Only
    what they said, never inferred."""
    return _call(store.set_preference, key, value)


@server.tool(annotations=READ_ONLY)
def progress_report() -> str:
    """Summary of the learner's progress: comfortable vs. still-learning topics,
    recent activity, checkpoint accuracy, and what's worth revisiting. Use when
    the user asks what they've learned."""
    return _call(store.progress_report)


@server.tool(annotations=READ_ONLY)
def search_decisions(
    repo_root: RepoRoot,
    query: Annotated[str, Field(description="Keywords about the area you're touching, e.g. 'cache redis invalidation'. Empty lists all.")],
    limit: Annotated[int, Field(ge=1, le=10)] = 3,
) -> str:
    """Find the project's recorded decisions relevant to what you're about to
    change, so you explain within past reasoning instead of contradicting it."""
    return _call(store.search_decisions, repo_root, query, limit)


@server.tool(annotations=WRITES)
def add_decision(
    repo_root: RepoRoot,
    title: Annotated[str, Field(description="Short, e.g. 'Sliding-window rate limit in Redis'.")],
    context: Annotated[str, Field(description="The problem, in one or two lines.")],
    decision: Annotated[str, Field(description="What was chosen.")],
    alternatives: Annotated[list[str], Field(description="Each rejected option with why, e.g. 'fixed window — 2x bursts at edges'.")],
    consequences: Annotated[str, Field(description="What the team now has to live with.")],
) -> str:
    """Record a decision with lasting weight as a numbered file in
    .learning/decisions/. Tell the user in one line when you do."""
    return _call(store.add_decision, repo_root, title, context, decision, alternatives, consequences)


@server.tool(annotations=WRITES)
def update_map(
    repo_root: RepoRoot,
    content: Annotated[str, Field(description="The full map: entry points, core modules, data flow, gotchas. Max 40 lines.")],
) -> str:
    """Replace the project map in .learning/map.md and stamp today's date.
    Update it when structure changes or you find a new gotcha."""
    return _call(store.update_map, repo_root, content)


def _gate_cli(repo_root: str, args: list[str], stdin: str | None = None) -> str:
    """Run the bundled gate. Never the repo's own .learning/gate.py: this
    server runs in any repo the user opens, and executing code shipped by a
    cloned repo would be arbitrary code execution. Version differences with
    the repo/CI copy are reported by `status` as a note."""
    try:
        root = gate.repo_root(repo_root)
    except gate.GateError as e:
        raise ToolError(str(e)) from e
    try:
        proc = subprocess.run([sys.executable, "-I", gate.__file__, *args, "--repo", str(root)],
                              input=stdin, capture_output=True, text=True, encoding="utf-8", timeout=300)
    except subprocess.TimeoutExpired as e:
        raise ToolError("The gate took longer than 5 minutes.") from e
    if proc.returncode != 0:
        raise ToolError(proc.stderr.strip().removeprefix("ownership gate: ") or "The gate failed.")
    return proc.stdout.strip()


Branch = Annotated[str, Field(description="Branch the PR will come from, if it differs from the current "
                                          "local branch (e.g. pushed as another name). Empty = current branch.")]
Base = Annotated[str, Field(description="Base ref the PR targets, e.g. 'origin/develop' or 'upstream/main' "
                                        "for a fork. Empty = from config / auto-detect.")]


def _opt(name: str, value: str) -> list[str]:
    return [f"--{name}", value] if value.strip() else []


@server.tool(annotations=READ_ONLY)
def gate_status(repo_root: RepoRoot, base: Base = "", branch: Branch = "") -> str:
    """Ownership check status of the current change: each changed file is new,
    stale (changed since it was verified), or ok, with sensitive, ignored and
    untracked files marked, plus the exact list that must be verified before
    saving. Use before the final check to know what to ask about."""
    return _gate_cli(repo_root, ["status", *_opt("base", base), *_opt("branch", branch)])


@server.tool(annotations=WRITES)
def save_check_report(
    repo_root: RepoRoot,
    summary: Annotated[str, Field(description="The developer's OWN summary of what changed, why, and what could "
                                              "break — their words, not yours. Fixing typos is fine.")],
    verified: Annotated[dict[str, list[str]], Field(description="File path → concepts the developer demonstrably "
                                                                "understands, e.g. {'src/rateLimit.js': ['sliding-window math', "
                                                                "'fail-open when Redis is down']}. No scores or mistakes.")],
    base: Base = "",
    branch: Branch = "",
) -> str:
    """Save the ownership report after the final check passes. It fingerprints
    every changed file so CI can tell if code changed afterwards. Refuses if a
    sensitive or changed-since-last-report file isn't verified — that refusal
    lists what is left to ask about."""
    payload = json.dumps({"summary": summary, "verified": verified}, ensure_ascii=False)
    return _gate_cli(repo_root, ["save", *_opt("base", base), *_opt("branch", branch)], stdin=payload)


def main() -> None:
    server.run()  # stdio: the client starts this process and talks over stdin/stdout


if __name__ == "__main__":
    main()
