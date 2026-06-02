"""Business-logic layer for the AI Interview Copilot.

Responsible for:
- Lazily creating / fetching copilot sessions
- Appending transcript segments
- Generating post-interview summaries
- Updating skill-coverage maps
"""
from __future__ import annotations

import asyncio
import logging
from concurrent.futures import Future
from datetime import UTC, datetime
from uuid import UUID

from fastapi import BackgroundTasks, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.candidate import Candidate
from app.models.interview import Interview
from app.models.interview_copilot import (
    InterviewCopilotSession,
    InterviewTranscriptSegment,
)
from app.models.job import Job
from app.schemas.auth import CurrentUser
from app.schemas.interview_copilot import (
    TranscriptSegmentCreate,
)
from app.services.ai.copilot_suggester import generate_interview_summary

logger = logging.getLogger(__name__)

# ── Event loop reference for WS notifications from background threads ─────────
# Set by the async startup handler in main.py.  Background tasks (which run in
# a thread pool) cannot directly await coroutines, so they use
# asyncio.run_coroutine_threadsafe() to schedule WS pushes on the main loop.
_main_event_loop: asyncio.AbstractEventLoop | None = None
_pending_ws_notifications: set[Future] = set()


def _notify_ws_from_thread(interview_id: UUID, event_type: object, data: dict) -> None:
    """Fire-and-forget: schedule a WS broadcast from a sync background thread."""
    from app.core.shutdown import is_shutting_down

    if is_shutting_down():
        return
    if _main_event_loop is None or _main_event_loop.is_closed():
        return
    from app.websocket.copilot_ws import notify_interview_clients

    fut = asyncio.run_coroutine_threadsafe(
        notify_interview_clients(str(interview_id), event_type, data),  # type: ignore[arg-type]
        _main_event_loop,
    )
    _pending_ws_notifications.add(fut)

    def _done(f: Future) -> None:
        _pending_ws_notifications.discard(f)
        try:
            f.result()
        except Exception:
            pass

    fut.add_done_callback(_done)


def cancel_pending_ws_notifications() -> None:
    """Cancel in-flight copilot WS notifications during shutdown."""
    for fut in list(_pending_ws_notifications):
        fut.cancel()
    _pending_ws_notifications.clear()


def _copilot_guard() -> None:
    """Raise 503 when the copilot feature is disabled."""
    if not get_settings().copilot_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI Interview Copilot is not enabled on this deployment.",
        )


class CopilotService:

    def __init__(self, db: Session) -> None:
        self._db = db

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _get_interview(self, interview_id: UUID, organization_id: UUID) -> Interview:
        interview = self._db.scalar(
            select(Interview).where(
                Interview.id == interview_id,
                Interview.organization_id == organization_id,
            )
        )
        if interview is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Interview not found.",
            )
        return interview

    def _get_or_create_session(
        self,
        interview_id: UUID,
        organization_id: UUID,
    ) -> InterviewCopilotSession:
        existing = self._db.scalar(
            select(InterviewCopilotSession).where(
                InterviewCopilotSession.interview_id == interview_id,
                InterviewCopilotSession.organization_id == organization_id,
            )
        )
        if existing:
            return existing

        sess = InterviewCopilotSession(
            organization_id=organization_id,
            interview_id=interview_id,
            status="active",
            skills_covered={},
        )
        self._db.add(sess)
        try:
            self._db.commit()
        except IntegrityError:
            # Another concurrent request already created the session (race condition
            # on the unique constraint). Roll back and return the existing row.
            self._db.rollback()
            existing = self._db.scalar(
                select(InterviewCopilotSession).where(
                    InterviewCopilotSession.interview_id == interview_id,
                    InterviewCopilotSession.organization_id == organization_id,
                )
            )
            if existing is None:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Failed to create or retrieve copilot session.",
                )
            return existing
        self._db.refresh(sess)
        logger.info(
            "copilot_session.created interview_id=%s session_id=%s",
            interview_id,
            sess.id,
        )
        return sess

    # ── Session ───────────────────────────────────────────────────────────────

    def get_or_create_session(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> InterviewCopilotSession:
        _copilot_guard()
        self._get_interview(interview_id, organization_id)  # access check
        return self._get_or_create_session(interview_id, organization_id)

    def get_session(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> InterviewCopilotSession:
        _copilot_guard()
        self._get_interview(interview_id, organization_id)  # access check
        sess = self._db.scalar(
            select(InterviewCopilotSession).where(
                InterviewCopilotSession.interview_id == interview_id,
                InterviewCopilotSession.organization_id == organization_id,
            )
        )
        if sess is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No copilot session for this interview. POST /session to start one.",
            )
        return sess

    # ── Transcript ────────────────────────────────────────────────────────────

    def add_transcript_segment(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: TranscriptSegmentCreate,
    ) -> InterviewTranscriptSegment:
        _copilot_guard()
        self._get_interview(interview_id, organization_id)
        sess = self._get_or_create_session(interview_id, organization_id)

        seg = InterviewTranscriptSegment(
            session_id=sess.id,
            interview_id=interview_id,
            organization_id=organization_id,
            speaker=payload.speaker.value,
            content=payload.content,
            offset_ms=payload.offset_ms,
            duration_ms=payload.duration_ms,
            source=payload.source,
        )
        self._db.add(seg)
        self._db.commit()
        self._db.refresh(seg)

        # Notify all connected copilot clients in real-time so TranscriptPanel
        # can append the segment without polling.
        from app.schemas.interview_copilot import WsEventType  # noqa: PLC0415
        _notify_ws_from_thread(
            interview_id,
            WsEventType.TRANSCRIPT_ADDED,
            {
                "id": str(seg.id),
                "session_id": str(seg.session_id),
                "interview_id": str(interview_id),
                "speaker": seg.speaker,
                "content": seg.content,
                "source": seg.source,
                "offset_ms": seg.offset_ms,
                "duration_ms": seg.duration_ms,
                "created_at": seg.created_at.isoformat() if seg.created_at else None,
            },
        )

        return seg

    def list_transcript_segments(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        limit: int = 200,
        offset: int = 0,
    ) -> list[InterviewTranscriptSegment]:
        _copilot_guard()
        self._get_interview(interview_id, organization_id)  # access check
        return list(
            self._db.scalars(
                select(InterviewTranscriptSegment)
                .where(
                    InterviewTranscriptSegment.interview_id == interview_id,
                    InterviewTranscriptSegment.organization_id == organization_id,
                )
                .order_by(InterviewTranscriptSegment.created_at)
                .limit(limit)
                .offset(offset)
            ).all()
        )

    # ── Summary ───────────────────────────────────────────────────────────────

    def trigger_summary(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        force: bool,
        background_tasks: BackgroundTasks,
    ) -> dict:
        """Queue async summary generation; returns immediately."""
        _copilot_guard()
        self._get_interview(interview_id, organization_id)
        sess = self._get_or_create_session(interview_id, organization_id)

        if sess.summary and not force:
            return {"queued": False, "reason": "summary_already_exists", "session_id": str(sess.id)}

        background_tasks.add_task(
            _run_summary_generation,
            interview_id=interview_id,
            session_id=sess.id,
            organization_id=organization_id,
        )
        return {"queued": True, "session_id": str(sess.id)}


# ── Background tasks (run in thread with own session) ─────────────────────────

def _run_summary_generation(
    *,
    interview_id: UUID,
    session_id: UUID,
    organization_id: UUID,
) -> None:
    """Background worker: generate post-interview summary and persist it."""
    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        interview = db.scalar(
            select(Interview).where(Interview.id == interview_id)
        )
        if interview is None:
            return

        sess = db.scalar(
            select(InterviewCopilotSession).where(
                InterviewCopilotSession.id == session_id
            )
        )
        if sess is None:
            return

        # Build full transcript string
        segments = list(
            db.scalars(
                select(InterviewTranscriptSegment)
                .where(InterviewTranscriptSegment.session_id == session_id)
                .order_by(InterviewTranscriptSegment.created_at)
            ).all()
        )
        full_transcript = "\n".join(
            f"[{seg.speaker.upper()}]: {seg.content}" for seg in segments
        )

        job_title = "Unknown Role"
        candidate_name = "Candidate"
        required_skills: list[str] = []

        if interview.job_id:
            job = db.get(Job, interview.job_id)
            if job:
                job_title = job.title or job_title
                if isinstance(getattr(job, "required_skills", None), list):
                    required_skills = [str(s) for s in job.required_skills[:20]]

        if interview.candidate_id:
            candidate = db.get(Candidate, interview.candidate_id)
            if candidate:
                first = getattr(candidate, "first_name", "") or ""
                last = getattr(candidate, "last_name", "") or ""
                candidate_name = f"{first} {last}".strip() or candidate_name

        result = generate_interview_summary(
            job_title=job_title,
            candidate_name=candidate_name,
            full_transcript=full_transcript,
            required_skills=required_skills,
        )

        sess.summary = result.summary
        sess.status = "summarized"
        sess.summarized_at = datetime.now(UTC)
        sess.prompt_tokens_used = (sess.prompt_tokens_used or 0) + result.prompt_tokens
        sess.completion_tokens_used = (sess.completion_tokens_used or 0) + result.completion_tokens

        db.commit()
        logger.info(
            "copilot_summary.completed session_id=%s fallback=%s",
            session_id,
            result.fallback_used,
        )

        # Push real-time notification so the frontend receives the summary
        # immediately rather than waiting for the polling timeout.
        from app.schemas.interview_copilot import WsEventType
        _notify_ws_from_thread(
            interview_id,
            WsEventType.SUMMARY_READY,
            {"session_id": str(session_id)},
        )

    except Exception as exc:
        db.rollback()
        logger.exception("copilot_summary.failed session_id=%s: %s", session_id, exc)
    finally:
        db.close()
