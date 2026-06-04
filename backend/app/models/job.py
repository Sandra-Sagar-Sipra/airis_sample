from __future__ import annotations

from datetime import datetime
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        primary_key=True,
        server_default=sa.text("gen_random_uuid()"),
    )
    organization_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), nullable=False, index=True)
    client_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("clients.id"),
        nullable=False,
        index=True,
    )

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, server_default="open", index=True)
    paused_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Optional fields for Phase 1 job spec.
    # Kept nullable so existing `JobService.create_job()` continues to work.
    location: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    salary_min: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    salary_max: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    salary_currency: Mapped[str | None] = mapped_column(String(3), nullable=True, server_default=sa.text("'USD'"))
    experience_min_years: Mapped[int | None] = mapped_column(Integer, nullable=True)
    experience_max_years: Mapped[int | None] = mapped_column(Integer, nullable=True)
    employment_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    urgency: Mapped[str | None] = mapped_column(String(20), nullable=True, server_default=sa.text("'standard'"))
    
    # Phase 2: Safe Extension (Raw JD & Parsing metadata)
    raw_jd_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    parsing_source: Mapped[str | None] = mapped_column(String(20), nullable=True)
    parsing_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Original JD document (PDF/DOCX/TXT) stored server-side; never expose filesystem paths in APIs.
    jd_document_key: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    jd_file_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # Async ATS / match-cache pipeline: queued → running → ready | failed (null = not tracked / legacy).
    enrichment_status: Mapped[str | None] = mapped_column(String(32), nullable=True)

    key_responsibilities: Mapped[list[str] | None] = mapped_column(ARRAY(String), nullable=True)
    
    filled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("profiles.id"),
        nullable=True,
        index=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        index=True,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    @property
    def jd_original_available(self) -> bool:
        return bool(self.jd_document_key)
