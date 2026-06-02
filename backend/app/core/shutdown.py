"""Application shutdown coordination for background work."""
from __future__ import annotations

import threading

_shutdown = threading.Event()


def mark_shutting_down() -> None:
    _shutdown.set()


def is_shutting_down() -> bool:
    return _shutdown.is_set()
