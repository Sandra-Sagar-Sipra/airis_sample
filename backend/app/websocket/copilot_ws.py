"""WebSocket handler for the AI Interview Copilot real-time channel.

Architecture:
- One WebSocket connection per browser tab per interview.
- In-memory ConnectionManager keyed by interview_id (works for single-server).
  For multi-server deployments: replace the in-process registry with a
  Redis pub/sub fan-out (Redis is already in requirements.txt).
- Auth: JWT passed as ?token= query param (browsers cannot set WS headers).
- Events pushed from background tasks via notify_interview_clients().

Event envelope:
  {"type": "<event_type>", "data": {...}, "ts": "<iso_datetime>"}
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from starlette.websockets import WebSocketState
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.profile import Profile
from app.models.role_permission import RolePermission
from app.schemas.interview_copilot import WsEventType

logger = logging.getLogger(__name__)

ws_router = APIRouter(tags=["interview-copilot-ws"])


# ── In-memory connection registry ─────────────────────────────────────────────

class _ConnectionManager:
    """Tracks active WebSocket connections keyed by interview_id."""

    def __init__(self) -> None:
        # interview_id (str) → list of WebSocket
        self._connections: dict[str, list[WebSocket]] = defaultdict(list)

    async def connect(self, interview_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self._connections[interview_id].append(ws)
        logger.info(
            "copilot_ws.connected interview_id=%s total=%d",
            interview_id,
            len(self._connections[interview_id]),
        )

    def disconnect(self, interview_id: str, ws: WebSocket) -> None:
        conns = self._connections.get(interview_id, [])
        if ws in conns:
            conns.remove(ws)
        logger.info(
            "copilot_ws.disconnected interview_id=%s remaining=%d",
            interview_id,
            len(conns),
        )

    async def broadcast(self, interview_id: str, message: dict) -> None:
        """Push a JSON message to all clients watching this interview."""
        conns = list(self._connections.get(interview_id, []))
        dead: list[WebSocket] = []
        for ws in conns:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(interview_id, ws)

    async def send_personal(self, ws: WebSocket, message: dict) -> None:
        try:
            await ws.send_json(message)
        except Exception:
            pass

    async def close_all(self, *, reason: str = "Server shutting down") -> None:
        """Close every active copilot WebSocket (application shutdown)."""
        all_conns: list[tuple[str, WebSocket]] = []
        for interview_id, conns in list(self._connections.items()):
            all_conns.extend((interview_id, ws) for ws in list(conns))
        self._connections.clear()

        closed = 0
        for interview_id, ws in all_conns:
            try:
                if ws.client_state == WebSocketState.CONNECTED:
                    await ws.close(code=1001, reason=reason)
                    closed += 1
            except Exception:
                pass
            logger.info("copilot_ws.registry.closed interview_id=%s", interview_id)
        if closed:
            logger.info("copilot_ws.registry.close_all total=%d", closed)


manager = _ConnectionManager()


# ── Auth helper (query-param JWT) ─────────────────────────────────────────────

def _validate_ws_token(token: str) -> dict | None:
    """Decode and validate a JWT. Returns the payload dict or None."""
    settings = get_settings()
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
        )
        return payload
    except JWTError:
        return None


def _check_copilot_permission(db: Session, user_id: str, organization_id: str) -> bool:
    """Return True if user has interviews:copilot permission.

    NOTE: The JWT `sub` claim contains the profile.id (UUID primary key), NOT a
    separate user_id column.  Profile.id IS the user identifier; there is no
    Profile.user_id column.
    """
    try:
        try:
            user_uuid = UUID(str(user_id))
        except ValueError:
            return False

        # Profile.id is the primary key / user identifier (same value as JWT sub).
        profile = db.scalar(
            select(Profile).where(Profile.id == user_uuid)
        )
        if profile is None:
            return False

        # Verify the profile belongs to the claimed organisation.
        try:
            org_uuid = UUID(str(organization_id))
        except ValueError:
            return False

        if profile.organization_id != org_uuid:
            return False

        # Check the permission via the profile's role_id (matches PermissionService.can_user).
        has_perm = db.scalar(
            select(RolePermission).where(
                RolePermission.organization_id == org_uuid,
                RolePermission.role_id == profile.role_id,
                RolePermission.permission == "interviews:copilot",
            )
        )
        return has_perm is not None

    except Exception as exc:
        logger.warning("copilot_ws.permission_check_failed: %s", exc)
        return False


# ── Event helpers ─────────────────────────────────────────────────────────────

def _event(event_type: WsEventType, data: dict) -> dict:
    return {
        "type": event_type.value,
        "data": data,
        "ts": datetime.now(UTC).isoformat(),
    }


# ── Public broadcast API (called from background tasks) ───────────────────────

async def notify_interview_clients(interview_id: str, event_type: WsEventType, data: dict) -> None:
    """Push a real-time event to all connected copilot clients for this interview."""
    await manager.broadcast(interview_id, _event(event_type, data))


# ── WebSocket endpoint ────────────────────────────────────────────────────────

@ws_router.websocket("/interviews/{interview_id}/copilot/ws")
async def copilot_websocket(
    interview_id: UUID,
    ws: WebSocket,
    token: str = "",
) -> None:
    """
    Real-time copilot channel.

    Connect with:  ws://host/api/v1/interviews/{id}/copilot/ws?token=<jwt>

    Client → Server messages:
      {"type": "ping"}   — keepalive

    Server → Client messages:
      {"type": "transcript_added",  "data": {...}, "ts": "..."}
      {"type": "suggestion_ready",  "data": {...}, "ts": "..."}
      {"type": "summary_ready",     "data": {...}, "ts": "..."}
      {"type": "session_updated",   "data": {...}, "ts": "..."}
      {"type": "error",             "data": {"detail": "..."}, "ts": "..."}
      {"type": "pong",              "data": {}, "ts": "..."}
    """
    interview_id_str = str(interview_id)
    settings = get_settings()

    # -- Feature guard
    if not settings.copilot_enabled:
        await ws.close(code=1008, reason="Copilot feature is not enabled.")
        return

    # -- Auth
    if not token:
        await ws.close(code=4001, reason="Missing authentication token.")
        return

    payload = _validate_ws_token(token)
    if payload is None:
        await ws.close(code=4001, reason="Invalid or expired token.")
        return

    user_id: str = payload.get("sub", "")
    organization_id: str = payload.get("org", "") or payload.get("organization_id", "")

    if not user_id or not organization_id:
        await ws.close(code=4001, reason="Token missing required claims.")
        return

    # -- Permission check
    db = SessionLocal()
    try:
        has_permission = _check_copilot_permission(db, user_id, organization_id)
    finally:
        db.close()

    if not has_permission:
        await ws.close(code=4003, reason="Insufficient permissions for copilot.")
        return

    # -- Accept and register
    await manager.connect(interview_id_str, ws)
    await manager.send_personal(
        ws,
        _event(
            WsEventType.SESSION_UPDATED,
            {"connected": True, "interview_id": interview_id_str},
        ),
    )

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type", "")
            if msg_type == WsEventType.PING.value:
                await manager.send_personal(ws, _event(WsEventType.PONG, {}))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("copilot_ws.error interview_id=%s: %s", interview_id_str, exc)
    finally:
        manager.disconnect(interview_id_str, ws)
