#!/usr/bin/env python3
"""Manage a project's .learning/ folder for the explain-as-you-build skill.

Usage:
  learning.py init <repo-root>
      Create .learning/ with templates and git-ignore the personal file.
      Safe to run again: existing files are never overwritten.

  learning.py decision <repo-root> "<title>"
      Create the next numbered decision record and print its path.

Standard library only, so it runs anywhere Python 3.8+ exists.
"""
import datetime
import re
import sys
from pathlib import Path

GITIGNORE_LINE = ".learning/*.local.md"
TODAY = datetime.date.today().isoformat()

MAP_TEMPLATE = f"""# Project map
Verified: {TODAY}

Entry points:
Core modules:
Data flow:
Gotchas:
"""

ME_TEMPLATE = f"""# What I know (personal — not committed)
Updated: {TODAY}

## Comfortable

## Learning

## Already explained

## Preferences
"""

DECISION_TEMPLATE = """# {num:04d} — {title}
Date: {date} · Status: accepted

Context:
Decision:
Alternatives:
-
Consequences:
"""


def write_if_missing(path: Path, content: str, created: list) -> None:
    # Never overwrite: these files hold the user's accumulated notes.
    if not path.exists():
        path.write_text(content, encoding="utf-8")
        created.append(path)


def ensure_gitignored(root: Path, created: list) -> None:
    gitignore = root / ".gitignore"
    existing = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
    if GITIGNORE_LINE in existing.splitlines():
        return
    # Keep the file's last line intact if it lacks a trailing newline.
    prefix = "" if existing == "" or existing.endswith("\n") else "\n"
    with gitignore.open("a", encoding="utf-8") as f:
        f.write(f"{prefix}{GITIGNORE_LINE}\n")
    created.append(f"{gitignore} (added {GITIGNORE_LINE})")


def init(root: Path) -> None:
    base = root / ".learning"
    (base / "decisions").mkdir(parents=True, exist_ok=True)
    created: list = []
    write_if_missing(base / "map.md", MAP_TEMPLATE, created)
    write_if_missing(base / "me.local.md", ME_TEMPLATE, created)
    ensure_gitignored(root, created)
    if created:
        print("Created:")
        for item in created:
            print(f"  {item}")
    else:
        print(f"{base} already set up; nothing changed.")


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug[:60] or "decision"


def decision(root: Path, title: str) -> None:
    folder = root / ".learning" / "decisions"
    if not folder.is_dir():
        sys.exit("No .learning/decisions/ here. Run `learning.py init` first.")
    # Next number = highest existing + 1, so deleted records never cause reuse.
    numbers = [int(m.group(1)) for p in folder.glob("*.md")
               if (m := re.match(r"(\d{4})-", p.name))]
    num = max(numbers, default=0) + 1
    path = folder / f"{num:04d}-{slugify(title)}.md"
    path.write_text(DECISION_TEMPLATE.format(num=num, title=title, date=TODAY),
                    encoding="utf-8")
    print(path)


def main(argv: list) -> None:
    if len(argv) >= 2 and argv[0] == "init":
        init(Path(argv[1]).resolve())
    elif len(argv) >= 3 and argv[0] == "decision":
        decision(Path(argv[1]).resolve(), " ".join(argv[2:]))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
