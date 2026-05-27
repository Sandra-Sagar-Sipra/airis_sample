"""SCHED-006: Interview reminder scheduling helpers.

Called from InterviewService and InterviewNotificationService to
create, cancel, and reschedule InterviewReminder rows in the DB.
All functions are synchronous (run inside the existing DB session).
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models.interview import Interview, InterviewParticipant
from app.models.interview_reminder import InterviewReminder

logger = logging.getLogger(__name__)

# Reminder offsets
_OFFSETS: dict[str, timedelta] = {
    "24h": timedelta(hours=24),
    "1h": timedelta(hours=1),
}

# Statuses that disqualify an interview from getting new reminders
_TERMINAL_STATUSES = frozenset({"cancelled", "no_show", "rescheduled"})


# ── Public API ─────────────────────────────────────────────────────────────────

def schedule_candidate_reminders(
    db: Session,
    interview: Interview,
    candidate_email: str,
) -> None:
    """Create 24h and 1h reminder rows for a candidate.

    Idempotent — skips creation if a non-cancelled reminder of the same
    type already exists for this interview + email combination.
    """
    if not candidate_email:
        return
    if interview.status in _TERMINAL_STATUSES:
        return

    scheduled_at = _ensure_utc(interview.scheduled_at)
    now = datetime.now(UTC)

    for reminder_type, offset in _OFFSETS.items():
        fire_at = scheduled_at - offset
        if fire_at <= now:
            logger.debug(
                "sched006: skipping %s reminder for interview %s — fire_at in the past",
                reminder_type,
                interview.id,
            )
            continue
        if _reminder_exists(db, interview.id, reminder_type, candidate_email):
            continue

        db.add(
            InterviewReminder(
                interview_id=interview.id,
                organization_id=interview.organization_id,
                reminder_type=reminder_type,
                recipient_type="candidate",
                recipient_email=candidate_email,
                scheduled_for=fire_at,
                status="scheduled",
            )
        )
        logger.info(
            "sched006: scheduled %s candidate reminder for interview %s → %s",
            reminder_type,
            interview.id,
            fire_at.isoformat(),
        )

    db.flush()


def schedule_interviewer_reminder(
    db: Session,
    interview: Interview,
    interviewer_email: str,
) -> None:
    """Create 24h and 1h reminder rows for one interviewer.

    Called when a participant is added or claims an interview.
    Idempotent — skips if reminder already exists.
    """
    if not interviewer_email:
        return
    if interview.status in _TERMINAL_STATUSES:
        return

    scheduled_at = _ensure_utc(interview.scheduled_at)
    now = datetime.now(UTC)

    for reminder_type, offset in _OFFSETS.items():
        fire_at = scheduled_at - offset
        if fire_at <= now:
            continue
        if _reminder_exists(db, interview.id, reminder_type, interviewer_email):
            continue

        db.add(
            InterviewReminder(
                interview_id=interview.id,
                organization_id=interview.organization_id,
                reminder_type=reminder_type,
                recipient_type="interviewer",
                recipient_email=interviewer_email,
                scheduled_for=fire_at,
                status="scheduled",
            )
        )
        logger.info(
            "sched006: scheduled %s interviewer reminder for interview %s → %s",
            reminder_type,
            interview.id,
            fire_at.isoformat(),
        )

    db.flush()


def cancel_all_reminders(db: Session, interview_id: UUID) -> int:
    """Mark all scheduled/processing reminders for an interview as cancelled.

    Returns the number of rows updated.
    """
    result = db.execute(
        update(InterviewReminder)
        .where(
            InterviewReminder.interview_id == interview_id,
            InterviewReminder.status.in_(["scheduled", "processing"]),
        )
        .values(status="cancelled")
        .returning(InterviewReminder.id)
    )
    count = len(result.fetchall())
    db.flush()
    if count:
        logger.info(
            "sched006: cancelled %d reminder(s) for interview %s", count, interview_id
        )
    return count


def cancel_participant_reminders(
    db: Session,
    interview_id: UUID,
    email: str,
) -> int:
    """Cancel pending reminders for a specific recipient email on an interview."""
    result = db.execute(
        update(InterviewReminder)
        .where(
            InterviewReminder.interview_id == interview_id,
            InterviewReminder.recipient_email == email,
            InterviewReminder.status.in_(["scheduled", "processing"]),
        )
        .values(status="cancelled")
        .returning(InterviewReminder.id)
    )
    count = len(result.fetchall())
    db.flush()
    return count


def reschedule_reminders(
    db: Session,
    interview: Interview,
    candidate_email: str | None,
) -> None:
    """Cancel existing reminders and create fresh ones for the new scheduled_at.

    Called when an interview's scheduled_at is updated.
    """
    cancel_all_reminders(db, interview.id)

    if candidate_email:
        schedule_candidate_reminders(db, interview, candidate_email)

    # Re-schedule for existing accepted participants
    participants = list(
        db.scalars(
            select(InterviewParticipant).where(
                InterviewParticipant.interview_id == interview.id,
                InterviewParticipant.status != "declined",
            )
        )
    )
    for participant in participants:
        email = _get_user_email(db, participant.user_id)
        if email:
            schedule_interviewer_reminder(db, interview, email)


def get_reminders_for_interview(
    db: Session, interview_id: UUID
) -> list[InterviewReminder]:
    """Return all reminder rows for an interview ordered by scheduled_for."""
    return list(
        db.scalars(
            select(InterviewReminder)
            .where(InterviewReminder.interview_id == interview_id)
            .order_by(InterviewReminder.scheduled_for.asc())
        )
    )


# ── Internal helpers ──────────────────────────────────────────────────────────

def _reminder_exists(
    db: Session,
    interview_id: UUID,
    reminder_type: str,
    email: str,
) -> bool:
    """Return True if a non-cancelled reminder already exists."""
    existing = db.scalar(
        select(InterviewReminder).where(
            InterviewReminder.interview_id == interview_id,
            InterviewReminder.reminder_type == reminder_type,
            InterviewReminder.recipient_email == email,
            InterviewReminder.status.not_in(["cancelled"]),
        )
    )
    return existing is not None


def _ensure_utc(dt: datetime) -> datetime:
    """Return a timezone-aware UTC datetime."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _get_user_email(db: Session, user_id: UUID) -> str | None:
    """Look up a user's email from the Profile table."""
    from app.models.profile import Profile  # local import to avoid circular dep

    profile = db.scalar(select(Profile).where(Profile.id == user_id))
    return profile.email if profile else None
