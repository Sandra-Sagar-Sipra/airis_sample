"""WebSocket for live AI Screening Interview.

Endpoint: /api/v1/ai-screenings/ws/{screening_id}
"""
from __future__ import annotations

import json
import logging
from collections.abc import Callable
from typing import TypeVar
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from starlette.websockets import WebSocketState

from app.core.shutdown import is_shutting_down
from app.db.session import db_session
from app.models.ai_screening import AIScreening
from app.services.ai_screening_service import AIScreeningService, is_substantive_answer
from app.websocket.registry import live_interview_ws_registry

logger = logging.getLogger(__name__)

ws_router = APIRouter()

T = TypeVar("T")


async def _send(ws: WebSocket, payload: dict) -> None:
    await ws.send_text(json.dumps(payload))


async def _close_ws(ws: WebSocket, *, code: int = 1000, reason: str = "") -> None:
    try:
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.close(code=code, reason=reason)
    except Exception:
        pass


def _with_db(fn: Callable[[AIScreeningService], T]) -> T:
    with db_session() as db:
        return fn(AIScreeningService(db))


def _load_screening(screening_id: UUID) -> AIScreening | None:
    with db_session() as db:
        return db.scalar(select(AIScreening).where(AIScreening.id == screening_id))


@ws_router.websocket("/ai-screenings/ws/{screening_id}")
async def ai_screening_live_ws(websocket: WebSocket, screening_id: UUID) -> None:
    """Real-time interview WebSocket for live AI screening sessions."""
    screening_id_str = str(screening_id)
    registered = False

    await websocket.accept()

    try:
        if is_shutting_down():
            await _send(websocket, {"type": "error", "message": "Server is shutting down."})
            return

        screening = _load_screening(screening_id)
        if screening is None:
            await _send(websocket, {"type": "error", "message": "Session not found."})
            await _close_ws(websocket, code=4004)
            return

        if screening.interview_mode != "live":
            await _send(websocket, {"type": "error", "message": "Not a live interview session."})
            await _close_ws(websocket, code=4003)
            return

        if screening.status == "completed":
            await _send(websocket, {"type": "error", "message": "Interview already completed."})
            await _close_ws(websocket, code=4003)
            return

        await live_interview_ws_registry.register(screening_id_str, websocket)
        registered = True

        org_id = screening.organization_id

        if screening.status == "pending":

            def start(svc: AIScreeningService):
                return svc.start_live_session(screening_id, org_id)

            _screening, opening_q = _with_db(start)
            await _send(
                websocket,
                {
                    "type": "question",
                    "text": opening_q,
                    "number": 1,
                    "followup": False,
                },
            )
        else:

            def last_question(svc: AIScreeningService):
                msgs = svc.get_live_messages(screening_id)
                return [m for m in msgs if m.role == "interviewer"]

            interviewer_msgs = _with_db(last_question)
            if interviewer_msgs:
                last = interviewer_msgs[-1]
                await _send(
                    websocket,
                    {
                        "type": "question",
                        "text": last.content,
                        "number": last.question_number or len(interviewer_msgs),
                        "followup": last.is_followup,
                    },
                )

        logger.info("ai_screening_ws.connected screening=%s", screening_id)

        transcript_parts: list[str] = []
        raw_parts: list[str] = []

        while not is_shutting_down():
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                logger.info("ai_screening_ws.disconnected screening=%s", screening_id)
                break

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await _send(websocket, {"type": "error", "message": "Invalid JSON."})
                continue

            msg_type = msg.get("type", "")

            if msg_type == "ping":
                await _send(websocket, {"type": "pong"})
                continue

            if msg_type == "transcript":
                if msg.get("transcript"):
                    transcript_parts.append(msg["transcript"])
                    logger.warning(
                        "Transcript received screening=%s chars=%d",
                        screening_id,
                        len(str(msg["transcript"])),
                    )
                if msg.get("raw"):
                    raw_parts.append(msg["raw"])
                continue

            if msg_type == "end_answer":
                full_transcript = " ".join(transcript_parts).strip()
                full_raw = " ".join(raw_parts).strip() or None
                transcript_parts.clear()
                raw_parts.clear()

                if not full_transcript:
                    await _send(websocket, {"type": "error", "message": "No transcript received."})
                    continue

                if not is_substantive_answer(full_transcript):
                    await _send(
                        websocket,
                        {
                            "type": "answer_rejected",
                            "message": "Please provide a fuller answer before moving to the next question.",
                        },
                    )
                    continue

                await _send(websocket, {"type": "thinking"})

                try:

                    def process(svc: AIScreeningService):
                        return svc.process_live_turn(
                            screening_id=screening_id,
                            org_id=org_id,
                            transcript=full_transcript,
                            raw_transcript=full_raw,
                        )

                    next_q, should_end = _with_db(process)
                except Exception as exc:
                    logger.exception("ai_screening_ws.process_turn_error screening=%s", screening_id)
                    await _send(websocket, {"type": "error", "message": str(exc)[:200]})
                    continue

                if next_q == "" and not should_end:
                    await _send(
                        websocket,
                        {
                            "type": "answer_rejected",
                            "message": "Please provide a fuller answer before moving to the next question.",
                        },
                    )
                    continue

                if should_end or next_q is None:
                    await _end_interview(websocket, screening_id, org_id)
                    break

                def count_questions(svc: AIScreeningService):
                    msgs = svc.get_live_messages(screening_id)
                    return sum(1 for m in msgs if m.role == "interviewer")

                q_num = _with_db(count_questions)
                await _send(
                    websocket,
                    {
                        "type": "question",
                        "text": next_q,
                        "number": q_num,
                        "followup": True,
                    },
                )
                continue

            if msg_type == "end_interview":
                await _end_interview(websocket, screening_id, org_id)
                break

        if is_shutting_down():
            await _send(websocket, {"type": "error", "message": "Server is shutting down."})

    except Exception as exc:
        logger.exception("ai_screening_ws.unhandled screening=%s: %s", screening_id, exc)
        try:
            await _send(websocket, {"type": "error", "message": "Unexpected server error."})
        except Exception:
            pass
    finally:
        if registered:
            await live_interview_ws_registry.unregister(screening_id_str, websocket)
        await _close_ws(websocket)


async def _end_interview(
    websocket: WebSocket,
    screening_id: UUID,
    org_id: UUID,
) -> None:
    try:

        def end(svc: AIScreeningService):
            return svc.end_live_interview(screening_id, org_id)

        ended = _with_db(end)
    except Exception:
        logger.exception("ai_screening_ws.end_failed screening=%s", screening_id)
        ended = _load_screening(screening_id)
        if ended is None:
            await _send(websocket, {"type": "error", "message": "Failed to end interview."})
            return

    summary = {
        "screening_id": str(ended.id),
        "status": ended.status,
        "overall_score": float(ended.overall_score) if ended.overall_score else None,
        "recommendation": ended.recommendation,
        "communication_score": float(ended.communication_score) if ended.communication_score else None,
        "experience_score": float(ended.experience_score) if ended.experience_score else None,
        "confidence_score": float(ended.confidence_score) if ended.confidence_score else None,
        "culture_fit_score": float(ended.culture_fit_score) if ended.culture_fit_score else None,
        "strengths": ended.strengths or [],
        "concerns": ended.concerns or [],
        "salary_expectation": ended.salary_expectation,
        "notice_period": ended.notice_period,
        "career_goals": ended.career_goals,
        "ai_summary": ended.ai_summary,
        "duration_seconds": ended.duration_seconds,
    }
    await _send(websocket, {"type": "interview_end", "summary": summary})
