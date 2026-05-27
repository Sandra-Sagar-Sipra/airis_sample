"""SCHED-006: Interview reminder tracking model.

One row per (interview, reminder_type, recipient_email).  The sweep task
atomically claims rows by flipping status → 'processing', then sends the
email and writes 'sent' or 'failed'.  Cancellation / reschedule flows
write 'cancelled' so the sweep ignores stale rows.
"""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class InterviewReminder(Base):
    __tablename__ = "interview_reminders"

    id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        primary_key=True,
        server_default=sa.text("gen_random_uuid()"),
    )
    interview_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("interviews.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    organization_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        nullable=False,
        index=True,
    )

    # "24h" or "1h"
    reminder_type: Mapped[str] = mapped_column(String(8), nullable=False)

    # "candidate" or "interviewer"
    recipient_type: Mapped[str] = mapped_column(String(16), nullable=False)

    # Email resolved at scheduling time to avoid extra lookups during send
    recipient_email: Mapped[str] = mapped_column(String(255), nullable=False)

    # UTC datetime when this reminder should fire
    scheduled_for: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )

    # scheduled → processing → sent | failed | skipped
    # cancelled: interview was cancelled or rescheduled before send
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=sa.text("'scheduled'"), index=True
    )

    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
