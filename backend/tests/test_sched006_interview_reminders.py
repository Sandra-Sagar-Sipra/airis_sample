"""SCHED-006: Interview reminder notification tests.

Acceptance criteria verified:
  1. 24h reminder scheduled correctly (fire_at = scheduled_at - 24h)
  2. 1h reminder scheduled correctly (fire_at = scheduled_at - 1h)
  3. Reminder skipped if interview is cancelled
  4. Reminder skipped if interview is rescheduled
  5. Reminder skipped if interview is no_show
  6. Reminders cancelled when interview status → cancelled
  7. Reminders rescheduled when scheduled_at changes
  8. Duplicate prevention — no duplicate reminders for same (interview, type, email)
  9. Past-fire-at reminders are NOT created (fire_at <= now)
 10. Sweep beat schedule is registered at 300s
 11. send_single_interview_reminder task is on the email queue
 12. sweep_interview_reminders task is on the background queue
 13. Participant reminder created on add_participant
 14. Participant reminder cancelled on remove_participant
 15. Email subject contains job title for candidate reminder
 16. Email subject contains candidate name for interviewer reminder
 17. Reminder status log fields are correct
 18. Timezone-naive scheduled_at handled correctly (treated as UTC)
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

from app.services.interview_reminder_service import (
    _ensure_utc,
    _reminder_exists,
    cancel_all_reminders,
    cancel_participant_reminders,
    reschedule_reminders,
    schedule_candidate_reminders,
    schedule_interviewer_reminder,
)
from app.services.interview_reminder_templates import (
    build_candidate_reminder,
    build_interviewer_reminder,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _make_interview(
    *,
    status: str = "scheduled",
    scheduled_at: datetime | None = None,
    candidate_id=None,
    job_id=None,
    interviewer_name: str = "Jane Smith",
    meeting_link: str = "https://meet.example.com/room",
    duration_minutes: int = 60,
):
    """Build a minimal mock Interview object."""
    iv = MagicMock()
    iv.id = uuid4()
    iv.organization_id = uuid4()
    iv.status = status
    iv.scheduled_at = scheduled_at or (datetime.now(UTC) + timedelta(hours=30))
    iv.candidate_id = candidate_id or uuid4()
    iv.job_id = job_id
    iv.interviewer_name = interviewer_name
    iv.meeting_link = meeting_link
    iv.duration_minutes = duration_minutes
    return iv


def _make_db():
    """Return a lightweight mock DB session."""
    db = MagicMock()
    added: list = []

    def _add(obj):
        added.append(obj)

    db.add.side_effect = _add
    db.flush.return_value = None
    db.commit.return_value = None
    db._added = added
    return db


# ── 1 & 2. Reminder timing ────────────────────────────────────────────────────

def test_24h_reminder_scheduled_at_correct_time():
    now = datetime.now(UTC)
    scheduled_at = now + timedelta(hours=30)
    interview = _make_interview(scheduled_at=scheduled_at)
    db = _make_db()

    # Suppress _reminder_exists lookup
    db.scalar.return_value = None

    schedule_candidate_reminders(db, interview, "candidate@example.com")

    fire_times = [obj.scheduled_for for obj in db._added if hasattr(obj, "scheduled_for")]
    reminder_24h = [t for t in fire_times if abs((t - (scheduled_at - timedelta(hours=24))).total_seconds()) < 2]
    assert reminder_24h, "24h reminder not found at expected time"


def test_1h_reminder_scheduled_at_correct_time():
    now = datetime.now(UTC)
    scheduled_at = now + timedelta(hours=30)
    interview = _make_interview(scheduled_at=scheduled_at)
    db = _make_db()
    db.scalar.return_value = None

    schedule_candidate_reminders(db, interview, "candidate@example.com")

    fire_times = [obj.scheduled_for for obj in db._added if hasattr(obj, "scheduled_for")]
    reminder_1h = [t for t in fire_times if abs((t - (scheduled_at - timedelta(hours=1))).total_seconds()) < 2]
    assert reminder_1h, "1h reminder not found at expected time"


# ── 3–5. Skip on terminal interview status ────────────────────────────────────

@pytest.mark.parametrize("bad_status", ["cancelled", "rescheduled", "no_show"])
def test_reminders_not_created_for_terminal_status(bad_status: str):
    interview = _make_interview(status=bad_status)
    db = _make_db()

    schedule_candidate_reminders(db, interview, "x@example.com")

    assert not db._added, f"Expected no reminders for status={bad_status}, got {db._added}"


# ── 6. Cancel reminders on interview cancellation ────────────────────────────

def test_cancel_all_reminders_updates_scheduled_and_processing():
    interview_id = uuid4()
    db = _make_db()

    mock_result = MagicMock()
    mock_result.fetchall.return_value = [(uuid4(),), (uuid4(),)]
    db.execute.return_value = mock_result

    count = cancel_all_reminders(db, interview_id)

    assert count == 2
    db.flush.assert_called()


# ── 7. Reschedule reminders when scheduled_at changes ────────────────────────

def test_reschedule_reminders_cancels_then_creates():
    interview = _make_interview()
    db = _make_db()

    # cancel_all_reminders execute returns empty
    cancel_result = MagicMock()
    cancel_result.fetchall.return_value = []
    # schedule checks (_reminder_exists) return None = not exists
    db.execute.return_value = cancel_result
    db.scalar.return_value = None

    reschedule_reminders(db, interview, "c@example.com")

    # Should have added new reminder rows
    assert any(hasattr(obj, "scheduled_for") for obj in db._added)


# ── 8. Duplicate prevention ───────────────────────────────────────────────────

def test_no_duplicate_reminders_when_already_exists():
    interview = _make_interview()
    db = _make_db()

    # _reminder_exists returns a mock (truthy) → skip creation
    db.scalar.return_value = MagicMock()

    schedule_candidate_reminders(db, interview, "existing@example.com")

    assert not db._added, "Should not add duplicate reminders"


# ── 9. Past-fire-at reminders not created ────────────────────────────────────

def test_past_fire_time_reminders_not_created():
    # Scheduled only 30 minutes away → both 24h and 1h fire_at are in the past
    interview = _make_interview(scheduled_at=datetime.now(UTC) + timedelta(minutes=30))
    db = _make_db()
    db.scalar.return_value = None

    schedule_candidate_reminders(db, interview, "c@example.com")

    assert not db._added, "Should not create reminders with fire_at in the past"


# ── 10. Beat schedule registered at 300s ─────────────────────────────────────

def test_sweep_beat_schedule_registered():
    from app.celery_app import celery_app

    schedule = celery_app.conf.beat_schedule
    entry = schedule.get("sched006-interview-reminder-sweep")
    assert entry is not None, "Beat schedule entry 'sched006-interview-reminder-sweep' not found"
    assert entry["task"] == "app.tasks.interview_reminder_tasks.sweep_interview_reminders"
    assert entry["schedule"] == 300


# ── 11 & 12. Task queue routing ───────────────────────────────────────────────

def test_send_single_reminder_task_on_email_queue():
    from app.tasks.interview_reminder_tasks import send_single_interview_reminder

    assert send_single_interview_reminder.queue == "email"


def test_sweep_task_on_background_queue():
    from app.tasks.interview_reminder_tasks import sweep_interview_reminders

    assert sweep_interview_reminders.queue == "background"


# ── 13 & 14. Participant reminder add/cancel ──────────────────────────────────

def test_schedule_interviewer_reminder_creates_rows():
    interview = _make_interview()
    db = _make_db()
    db.scalar.return_value = None  # no duplicates

    schedule_interviewer_reminder(db, interview, "interviewer@example.com")

    rows = [obj for obj in db._added if hasattr(obj, "recipient_type")]
    assert all(r.recipient_type == "interviewer" for r in rows)
    assert len(rows) == 2  # 24h + 1h


def test_cancel_participant_reminders():
    db = _make_db()
    result = MagicMock()
    result.fetchall.return_value = [(uuid4(),)]
    db.execute.return_value = result

    count = cancel_participant_reminders(db, uuid4(), "person@example.com")
    assert count == 1


# ── 15. Candidate email subject includes job title ────────────────────────────

def test_candidate_reminder_subject_contains_job_title():
    interview_dt = datetime.now(UTC) + timedelta(hours=25)
    email = build_candidate_reminder(
        reminder_type="24h",
        candidate_name="Alice",
        job_title="Software Engineer",
        interview_dt=interview_dt,
        duration_minutes=60,
        interviewer_name="Bob",
        meeting_link="https://meet.example.com",
    )
    assert "Software Engineer" in email.subject
    assert "Alice" in email.body
    assert "Bob" in email.body
    assert "https://meet.example.com" in email.body


# ── 16. Interviewer email subject contains candidate name ─────────────────────

def test_interviewer_reminder_subject_contains_candidate_name():
    interview_dt = datetime.now(UTC) + timedelta(hours=25)
    email = build_interviewer_reminder(
        reminder_type="1h",
        candidate_name="Charlie Brown",
        job_title="Data Scientist",
        interview_dt=interview_dt,
        duration_minutes=45,
        meeting_link="https://meet.example.com/ds",
    )
    assert "Charlie Brown" in email.subject
    assert "Data Scientist" in email.body
    assert "https://meet.example.com/ds" in email.body


# ── 17. Reminder log fields ───────────────────────────────────────────────────

def test_reminder_row_fields():
    interview = _make_interview()
    db = _make_db()
    db.scalar.return_value = None

    schedule_candidate_reminders(db, interview, "c@example.com")

    rows = [obj for obj in db._added if hasattr(obj, "reminder_type")]
    assert len(rows) == 2
    for row in rows:
        assert row.reminder_type in ("24h", "1h")
        assert row.recipient_type == "candidate"
        assert row.recipient_email == "c@example.com"
        assert row.status == "scheduled"
        assert row.interview_id == interview.id
        assert row.organization_id == interview.organization_id


# ── 18. Timezone-naive scheduled_at handled as UTC ────────────────────────────

def test_naive_scheduled_at_treated_as_utc():
    naive_dt = datetime.now() + timedelta(hours=30)
    assert naive_dt.tzinfo is None

    aware = _ensure_utc(naive_dt)
    assert aware.tzinfo is not None
    assert aware.utcoffset().total_seconds() == 0


# ── Email content rendering ───────────────────────────────────────────────────

def test_candidate_reminder_includes_meeting_link():
    email = build_candidate_reminder(
        reminder_type="1h",
        candidate_name="Dana",
        job_title=None,
        interview_dt=datetime.now(UTC) + timedelta(hours=2),
        duration_minutes=None,
        interviewer_name=None,
        meeting_link="https://zoom.us/j/123",
    )
    assert "https://zoom.us/j/123" in email.body


def test_reminder_body_fallbacks_when_no_optional_fields():
    email = build_candidate_reminder(
        reminder_type="24h",
        candidate_name="",
        job_title=None,
        interview_dt=datetime.now(UTC) + timedelta(hours=25),
        duration_minutes=None,
        interviewer_name=None,
        meeting_link=None,
    )
    assert "To be provided" in email.body  # meeting link fallback
    assert "Candidate" in email.body       # name fallback


# ── Async task execution — sweep claims rows ──────────────────────────────────

def test_sweep_task_claims_scheduled_rows():
    """The sweep atomically sets status=processing and dispatches send tasks."""
    from unittest.mock import patch

    # The task imports SessionLocal inside the function body, so we patch the
    # source module (app.db.session) which is the import target.
    with patch("app.db.session.SessionLocal") as MockSession, \
         patch("app.tasks.interview_reminder_tasks.send_single_interview_reminder") as mock_send:

        mock_db = MagicMock()
        MockSession.return_value = mock_db

        # Simulate the UPDATE RETURNING two reminder IDs
        mock_result = MagicMock()
        fake_ids = [uuid4(), uuid4()]
        mock_result.fetchall.return_value = [(i,) for i in fake_ids]
        mock_db.execute.return_value = mock_result
        mock_db.commit.return_value = None

        from app.tasks.interview_reminder_tasks import sweep_interview_reminders

        result = sweep_interview_reminders()

        assert result["claimed"] == 2
        assert result["dispatched"] == 2
        assert mock_send.apply_async.call_count == 2


# ── Retry behavior ────────────────────────────────────────────────────────────

def test_send_reminder_task_has_retry_policy():
    from app.tasks.interview_reminder_tasks import send_single_interview_reminder

    assert send_single_interview_reminder.max_retries == 3
    assert send_single_interview_reminder.retry_backoff is True
