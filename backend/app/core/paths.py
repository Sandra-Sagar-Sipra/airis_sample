"""Deployment-safe filesystem anchors (Railway, local dev, Windows, macOS)."""
from __future__ import annotations

import json
import os
import tempfile
import time
from functools import lru_cache
from pathlib import Path

# app/core/paths.py -> parents[0]=core, [1]=app, [2]=backend project root
BACKEND_ROOT = Path(__file__).resolve().parents[2]


@lru_cache(maxsize=32)
def optional_debug_log_file(filename: str) -> Path | None:
    """
    Resolve a writable debug log path without assuming repo/monorepo depth.

    Order: DEBUG_LOG_DIR env -> BACKEND_ROOT/logs -> system temp.
    Returns None when disabled or no writable location (never raises).
    """
    if os.environ.get("DEBUG_LOG_ENABLED", "").lower() in ("0", "false", "no"):
        return None

    bases: list[Path] = []
    env_dir = os.environ.get("DEBUG_LOG_DIR", "").strip()
    if env_dir:
        bases.append(Path(env_dir))
    bases.append(BACKEND_ROOT / "logs")
    bases.append(Path(tempfile.gettempdir()) / "airis-logs")

    for base in bases:
        try:
            base.mkdir(parents=True, exist_ok=True)
            probe = base / filename
            with probe.open("a", encoding="utf-8"):
                pass
            return probe
        except OSError:
            continue
    return None


def append_debug_log(filename: str, payload: dict) -> None:
    """Best-effort NDJSON debug line; failures are ignored (must not break requests)."""
    path = optional_debug_log_file(filename)
    if path is None:
        return
    entry = {**payload, "timestamp": int(time.time() * 1000)}
    try:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=True, default=str) + "\n")
    except OSError:
        pass
