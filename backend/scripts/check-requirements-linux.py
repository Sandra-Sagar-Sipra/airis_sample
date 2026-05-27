#!/usr/bin/env python3
"""Fail if requirements.txt references Windows-only packages (for CI / pre-deploy checks)."""
from __future__ import annotations

import re
import sys
from pathlib import Path

BLOCKED = re.compile(
    r"^\s*(pywin32|pypiwin32|pythonnet|clr_loader|pyreadline3?|win32-setctime)\b",
    re.IGNORECASE,
)

ROOT = Path(__file__).resolve().parents[1]
REQUIREMENTS = ROOT / "requirements.txt"


def main() -> int:
    if not REQUIREMENTS.is_file():
        print(f"missing {REQUIREMENTS}", file=sys.stderr)
        return 1
    bad: list[str] = []
    for line in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        stripped = line.split("#", 1)[0].strip()
        if not stripped or stripped.startswith("-"):
            continue
        if BLOCKED.match(stripped):
            bad.append(line)
    if bad:
        print("Windows-only packages found in requirements.txt:", file=sys.stderr)
        for line in bad:
            print(f"  {line}", file=sys.stderr)
        return 1
    print("requirements.txt OK for Linux (no blocked packages)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
