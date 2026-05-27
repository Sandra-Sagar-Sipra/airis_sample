"""SCHED-006: Interview reminder Celery tasks.

Two tasks:
  sweep_interview_reminders  — periodic beat task (every 5 min).  Finds
      scheduled reminders that are due, atomically claims them, and sends
      each email.  Deduplication is guaranteed by the 'processing' state
      transition inside a single UPDATE … RETURNING.

  send_single_interview_reminder  — sends one reminder row by ID; called
      by the sweep for per-reminder retry isolation.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from celery import Task

from app.celery_app import QUEUE_BACKGROUND, QUEUE_EMAIL, celery_app

logger = logging.getLogger(__name__)

# Statuses that mean "do not send — interview is no longer active"
_SKIP_STATUSES = frozenset({"cancelled", "no_show", "rescheduled"})


# ── Sweep ─────────────────────────────────────────────────────────────────────

@celery_app.task(
    name="app.tasks.interview_reminder_tasks.sweep_interview_reminders",
    queue=QUEUE_BACKGROUND,
    time_limit=120,
    ignore_result=False,
)
def sweep_interview_reminders() -> dict[str, Any]:
    """Periodic task: find due reminders, claim them, dispatch send tasks.

    Atomically updates status=scheduled → processing for all reminders whose
    scheduled_for ≤ now, then enqueues one send task per claimed row.
    This guarantees no double-sends across overlapping sweep runs.
    """
    from sqlalchemy import update
    from sqlalchemy.dialects.postgresql import insert  # noqa: F401 — used by type checker

    from app.db.session import SessionLocal
    from app.models.interview_reminder import InterviewReminder

    db = SessionLocal()
    try:
        now = datetime.now(UTC)

        # Atomic claim: flip 'scheduled' → 'processing' for overdue rows.
        result = db.execute(
            update(InterviewReminder)
            .where(
                InterviewReminder.status == "scheduled",
                InterviewReminder.scheduled_for <= now,
            )
            .values(status="processing")
            .returning(InterviewReminder.id)
        )
        claimed_ids: list[str] = [str(row[0]) for row in result.fetchall()]
        db.commit()

        if not claimed_ids:
            logger.debug("interview_reminder_tasks.sweep: nothing due")
            return {"claimed": 0, "dispatched": 0}

        logger.info(
            "interview_reminder_tasks.sweep: claimed %d reminder(s)", len(claimed_ids)
        )

        dispatched = 0
        for reminder_id in claimed_ids:
            send_single_interview_reminder.apply_async(
                kwargs={"reminder_id": reminder_id},
                queue=QUEUE_EMAIL,
            )
            dispatched += 1

        return {"claimed": len(claimed_ids), "dispatched": dispatched}
    finally:
        db.close()


# ── Single-reminder sender ─────────────────────────────────────────────────────

@celery_app.task(
    name="app.tasks.interview_reminder_tasks.send_single_interview_reminder",
    bind=True,
    max_retries=3,
    retry_backoff=True,
    retry_backoff_max=120,
    retry_jitter=True,
    queue=QUEUE_EMAIL,
    time_limit=60,
)
def send_single_interview_reminder(
    self: Task, *, reminder_id: str
) -> dict[str, Any]:
    """Send one interview reminder and update its DB status.

    On success → status='sent'.
    If interview is cancelled/rescheduled → status='skipped'.
    On transient failure → retry; after max retries → status='failed'.
    """
    from sqlalchemy import select

    from app.db.session import SessionLocal
    from app.models.candidate import Candidate
    from app.models.interview import Interview
    from app.models.interview_reminder import InterviewReminder
    from app.models.job import Job
    from app.services.interview_reminder_templates import (
        build_candidate_reminder,
        build_interviewer_reminder,
    )

    db = SessionLocal()
    try:
        reminder = db.scalar(
            select(InterviewReminder).where(
                InterviewReminder.id == UUID(reminder_id)
            )
        )
        if reminder is None:
            logger.warning(
                "interview_reminder_tasks.send: reminder %s not found", reminder_id
            )
            return {"status": "not_found", "reminder_id": reminder_id}

        # If already terminal (e.g. second retry after partial success)
        if reminder.status in {"sent", "skipped", "failed", "cancelled"}:
            logger.info(
                "interview_reminder_tasks.send: reminder %s already %s — skipping",
                reminder_id,
                reminder.status,
            )
            return {"status": reminder.status, "reminder_id": reminder_id}

        # Load interview
        interview = db.scalar(
            select(Interview).where(Interview.id == reminder.interview_id)
        )
        if interview is None:
            _mark(db, reminder, "skipped", "interview not found")
            return {"status": "skipped", "reason": "interview_not_found"}

        # Skip if interview no longer active
        if interview.status in _SKIP_STATUSES:
            _mark(db, reminder, "skipped", f"interview status={interview.status}")
            logger.info(
                "interview_reminder_tasks.send: skipped reminder %s (interview %s)",
                reminder_id,
                interview.status,
            )
            return {"status": "skipped", "interview_status": interview.status}

        # Resolve display data
        candidate_name = "Candidate"
        if interview.candidate_id:
            candidate = db.scalar(
                select(Candidate).where(Candidate.id == interview.candidate_id)
            )
            if candidate:
                candidate_name = f"{candidate.first_name} {candidate.last_name}".strip()

        job_title: str | None = None
        if interview.job_id:
            job = db.scalar(select(Job).where(Job.id == interview.job_id))
            if job:
                job_title = job.title

        # Build email
        if reminder.recipient_type == "candidate":
            email_obj = build_candidate_reminder(
                reminder_type=reminder.reminder_type,
                candidate_name=candidate_name,
                job_title=job_title,
                interview_dt=interview.scheduled_at,
                duration_minutes=interview.duration_minutes,
                interviewer_name=interview.interviewer_name,
                meeting_link=interview.meeting_link,
            )
        else:
            email_obj = build_interviewer_reminder(
                reminder_type=reminder.reminder_type,
                candidate_name=candidate_name,
                job_title=job_title,
                interview_dt=interview.scheduled_at,
                duration_minutes=interview.duration_minutes,
                meeting_link=interview.meeting_link,
            )

        # Send
        _send_smtp(
            to_email=reminder.recipient_email,
            subject=email_obj.subject,
            body=email_obj.body,
        )

        _mark(db, reminder, "sent")
        logger.info(
            "interview_reminder_tasks.sent reminder=%s type=%s to=%s",
            reminder_id,
            reminder.reminder_type,
            reminder.recipient_email,
        )
        return {
            "status": "sent",
            "reminder_id": reminder_id,
            "to": reminder.recipient_email,
            "type": reminder.reminder_type,
        }

    except Exception as exc:
        # On transient failures: retry; on final failure: mark failed
        retries_left = self.max_retries - self.request.retries
        logger.warning(
            "interview_reminder_tasks.send_failed reminder=%s retries_left=%d error=%s",
            reminder_id,
            retries_left,
            str(exc)[:300],
        )
        if retries_left <= 0:
            # Retries exhausted — persist failure
            try:
                db2 = SessionLocal()
                try:
                    r = db2.scalar(
                        select(InterviewReminder).where(
                            InterviewReminder.id == UUID(reminder_id)
                        )
                    )
                    if r and r.status == "processing":
                        _mark(db2, r, "failed", str(exc)[:500])
                finally:
                    db2.close()
            except Exception:
                logger.exception(
                    "interview_reminder_tasks: failed to persist failure for %s",
                    reminder_id,
                )
        raise self.retry(exc=exc) from exc
    finally:
        db.close()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _mark(
    db: Any,
    reminder: Any,
    status: str,
    failure_reason: str | None = None,
) -> None:
    """Persist reminder status change and commit."""
    reminder.status = status
    if status == "sent":
        reminder.sent_at = datetime.now(UTC)
    if failure_reason:
        reminder.failure_reason = failure_reason
    db.add(reminder)
    db.commit()


def _send_smtp(*, to_email: str, subject: str, body: str) -> None:
    """Send a plain-text email via SMTP. Raises on failure (triggers Celery retry)."""
    import smtplib
    from email.message import EmailMessage

    from app.core.config import get_settings

    settings = get_settings()
    if not settings.smtp_user or not settings.smtp_password or not settings.smtp_from:
        raise RuntimeError("SMTP credentials not configured — cannot send reminder.")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = settings.smtp_from
    msg["To"] = to_email
    msg.set_content(body)

    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as server:
        server.starttls()
        server.login(settings.smtp_user, settings.smtp_password)
        server.send_message(msg)
