"""Central registry for AI Screening live-interview WebSocket connections.

Used to close all active sockets during application shutdown so uvicorn can exit
promptly after Ctrl+C instead of waiting on hung connections.
"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict

from starlette.websockets import WebSocket, WebSocketState

logger = logging.getLogger(__name__)


class LiveInterviewWsRegistry:
    def __init__(self) -> None:
        self._connections: dict[str, list[WebSocket]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def register(self, screening_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._connections[screening_id].append(ws)
        logger.info(
            "ai_screening_ws.registry.register screening=%s total=%d",
            screening_id,
            len(self._connections[screening_id]),
        )

    async def unregister(self, screening_id: str, ws: WebSocket) -> None:
        async with self._lock:
            conns = self._connections.get(screening_id, [])
            if ws in conns:
                conns.remove(ws)
            if not conns:
                self._connections.pop(screening_id, None)
        logger.info("ai_screening_ws.registry.unregister screening=%s", screening_id)

    async def close_all(self, *, reason: str = "Server shutting down") -> None:
        async with self._lock:
            snapshot = [
                (sid, list(conns))
                for sid, conns in self._connections.items()
            ]
            self._connections.clear()

        closed = 0
        for screening_id, conns in snapshot:
            for ws in conns:
                if await _close_ws(ws, code=1001, reason=reason):
                    closed += 1
            logger.info(
                "ai_screening_ws.registry.closed screening=%s count=%d",
                screening_id,
                len(conns),
            )
        if closed:
            logger.info("ai_screening_ws.registry.close_all total=%d", closed)


live_interview_ws_registry = LiveInterviewWsRegistry()


async def _close_ws(ws: WebSocket, *, code: int, reason: str) -> bool:
    try:
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.close(code=code, reason=reason)
            return True
    except Exception:
        pass
    return False


async def shutdown_all_websockets() -> None:
    """Close AI Screening live sockets and copilot sockets."""
    await live_interview_ws_registry.close_all()
    from app.websocket.copilot_ws import manager as copilot_manager

    await copilot_manager.close_all()
