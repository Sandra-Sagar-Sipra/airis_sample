"""ORM model for per-question interview segments."""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AIScreeningSegment(Base):
    """One recorded answer segment per question within a live AI screening."""

    __tablename__ = "ai_screening_segments"

    id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True,
        server_default=sa.text("gen_random_uuid()"),
    )
    screening_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("ai_screenings.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    question_number: Mapped[int] = mapped_column(Integer, nullable=False)
    question_text: Mapped[str] = mapped_column(Text, nullable=False)
    transcript: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Seconds elapsed from interview start (recorded by the browser)
    question_start_seconds: Mapped[float | None] = mapped_column(Numeric(10, 3), nullable=True)
    answer_start_seconds: Mapped[float | None] = mapped_column(Numeric(10, 3), nullable=True)
    answer_end_seconds: Mapped[float | None] = mapped_column(Numeric(10, 3), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Numeric(10, 3), nullable=True)

    # Supabase storage path for this segment's video clip
    video_clip_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa.text("now()"),
    )
