"""SCHED-006: Interview reminder email templates.

Builds plain-text subject + body for 24h and 1h reminder emails sent to
candidates and interviewers.  No external AI calls — purely static text
with variable substitution so sending is fast and reliable.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_CANDIDATE_24H_SUBJECT = "Reminder: Your interview tomorrow — {job_title}"
_CANDIDATE_1H_SUBJECT  = "Reminder: Your interview in 1 hour — {job_title}"
_INTERVIEWER_24H_SUBJECT = "Reminder: Interview scheduled for tomorrow — {candidate_name}"
_INTERVIEWER_1H_SUBJECT  = "Reminder: Interview in 1 hour — {candidate_name}"

_CANDIDATE_BODY = """\
Hi {candidate_name},

This is a reminder about your upcoming interview{job_title_phrase}.

  Date & Time : {interview_datetime}
  Duration    : {duration}
  Interviewer : {interviewer_name}
  Meeting Link: {meeting_link}

Please join the meeting at the scheduled time. If you have any questions,
reach out to your recruiter.

Best regards,
AIRIS Recruitment Platform
"""

_INTERVIEWER_BODY = """\
Hi,

This is a reminder about your upcoming interview with {candidate_name}{job_title_phrase}.

  Date & Time : {interview_datetime}
  Duration    : {duration}
  Candidate   : {candidate_name}
  Meeting Link: {meeting_link}

Please join the meeting at the scheduled time.

Best regards,
AIRIS Recruitment Platform
"""


@dataclass(frozen=True, slots=True)
class ReminderEmail:
    subject: str
    body: str


def _fmt_datetime(dt: datetime) -> str:
    """Format a UTC datetime as a human-readable string in UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.strftime("%A, %d %B %Y at %H:%M UTC")


def _fmt_duration(minutes: int | None) -> str:
    if not minutes:
        return "TBD"
    if minutes < 60:
        return f"{minutes} minutes"
    h = minutes // 60
    m = minutes % 60
    return f"{h}h {m}m" if m else f"{h}h"


def build_candidate_reminder(
    *,
    reminder_type: str,
    candidate_name: str,
    job_title: str | None,
    interview_dt: datetime,
    duration_minutes: int | None,
    interviewer_name: str | None,
    meeting_link: str | None,
) -> ReminderEmail:
    """Build the candidate-facing reminder email."""
    job_title_phrase = f" for the {job_title} role" if job_title else ""
    subject_tmpl = _CANDIDATE_24H_SUBJECT if reminder_type == "24h" else _CANDIDATE_1H_SUBJECT
    subject = subject_tmpl.format(job_title=job_title or "your upcoming role")

    body = _CANDIDATE_BODY.format(
        candidate_name=candidate_name or "Candidate",
        job_title_phrase=job_title_phrase,
        interview_datetime=_fmt_datetime(interview_dt),
        duration=_fmt_duration(duration_minutes),
        interviewer_name=interviewer_name or "Your interviewer",
        meeting_link=meeting_link or "To be provided",
    )
    return ReminderEmail(subject=subject, body=body)


def build_interviewer_reminder(
    *,
    reminder_type: str,
    candidate_name: str,
    job_title: str | None,
    interview_dt: datetime,
    duration_minutes: int | None,
    meeting_link: str | None,
) -> ReminderEmail:
    """Build the interviewer-facing reminder email."""
    job_title_phrase = f" for the {job_title} role" if job_title else ""
    subject_tmpl = _INTERVIEWER_24H_SUBJECT if reminder_type == "24h" else _INTERVIEWER_1H_SUBJECT
    subject = subject_tmpl.format(candidate_name=candidate_name or "Candidate")

    body = _INTERVIEWER_BODY.format(
        candidate_name=candidate_name or "Candidate",
        job_title_phrase=job_title_phrase,
        interview_datetime=_fmt_datetime(interview_dt),
        duration=_fmt_duration(duration_minutes),
        meeting_link=meeting_link or "To be provided",
    )
    return ReminderEmail(subject=subject, body=body)
