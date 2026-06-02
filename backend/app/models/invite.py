from __future__ import annotations

from datetime import datetime
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

# F-INV-05: full invite lifecycle statuses
INVITE_STATUS_SENT = "sent"
INVITE_STATUS_OPENED = "opened"
INVITE_STATUS_ACCEPTED = "accepted"
INVITE_STATUS_EXPIRED = "expired"

INVITE_STATUSES = (
    INVITE_STATUS_SENT,
    INVITE_STATUS_OPENED,
    INVITE_STATUS_ACCEPTED,
    INVITE_STATUS_EXPIRED,
)


class Invite(Base):
    __tablename__ = "invites"
    __table_args__ = (
        UniqueConstraint("token", name="uq_invites_token"),
    )

    id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        primary_key=True,
        server_default=sa.text("gen_random_uuid()"),
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    organization_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("organizations.id"),
        nullable=False,
        index=True,
    )
    role: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    token: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default=sa.text("'sent'"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    # F-INV-05: per-transition timestamps
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # F-INV-04: email delivery tracking
    # delivery_status: pending → sent (SMTP accepted) | failed (all retries exhausted)
    delivery_status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=sa.text("'pending'")
    )
    delivery_provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    message_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    delivery_attempts: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, server_default=sa.text("0")
    )
    last_delivery_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_delivery_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
