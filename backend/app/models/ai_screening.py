"""SQLAlchemy ORM models for the AI Screening layer (async + live interview).

Four tables form the core entity graph:
  ai_screenings              — one screening session per candidate×job pairing
  ai_screening_questions     — AI-generated questions attached to a screening
  ai_screening_answers       — recruiter-entered or uploaded candidate responses
  ai_screening_evaluations   — per-answer AI evaluation & scores
"""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Text, Boolean, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AIScreening(Base):
    """Top-level screening session — one per candidate × job round."""

    __tablename__ = "ai_screenings"

    id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        primary_key=True,
        server_default=sa.text("gen_random_uuid()"),
    )
    organization_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), nullable=False, index=True
    )
    candidate_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("candidates.id"),
        nullable=False,
        index=True,
    )
    job_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("jobs.id"),
        nullable=True,
        index=True,
    )
    # Link to the pipeline entry that triggered this screening
    pipeline_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("pipelines.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_by: Mapped[UUID | None] = mapped_column(PGUUID(as_uuid=True), nullable=True)

    # Lifecycle ---------------------------------------------------------------
    # pending → generating_questions → questions_ready → evaluating → completed
    #                                                                → failed
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="pending", index=True
    )

    # Screening configuration -------------------------------------------------
    screening_type: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="technical"
    )
    ai_model: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Incomplete reason (set when interview did not meet scoring thresholds) ----
    # status = "incomplete" when this is populated
    incomplete_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Aggregate AI scores (0–100) populated after evaluation ------------------
    overall_score: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    communication_score: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    technical_score: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    confidence_score: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)

    # AI recommendation -------------------------------------------------------
    recommendation: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # Human-readable summaries ------------------------------------------------
    ai_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    recruiter_summary: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Recruiter override decision (overrides AI recommendation) ---------------
    recruiter_decision: Mapped[str | None] = mapped_column(String(32), nullable=True)
    recruiter_notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Metadata used by the AI during generation ------------------------------
    generation_context: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # AI usage tracking -------------------------------------------------------
    prompt_tokens_used: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens_used: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Live-interview mode -----------------------------------------------------
    # 'async' (default recruiter-enters-answers flow) | 'live' (video interview)
    interview_mode: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa.text("'async'")
    )
    # Candidate join token (live mode only)
    session_token: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True)
    livekit_room_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    candidate_name_snapshot: Mapped[str | None] = mapped_column(String(255), nullable=True)
    job_title_snapshot: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Live interview timing ---------------------------------------------------
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)

    # Additional scores for live interview evaluation -------------------------
    experience_score: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    culture_fit_score: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)

    # Structured findings (live interview) ------------------------------------
    strengths: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    concerns: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    key_projects_mentioned: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    salary_expectation: Mapped[str | None] = mapped_column(String(255), nullable=True)
    notice_period: Mapped[str | None] = mapped_column(String(128), nullable=True)
    career_goals: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Timestamps --------------------------------------------------------------
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=sa.text("now()"),
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class AIScreeningQuestion(Base):
    """AI-generated question within a screening session."""

    __tablename__ = "ai_screening_questions"

    id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        primary_key=True,
        server_default=sa.text("gen_random_uuid()"),
    )
    screening_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("ai_screenings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Question metadata -------------------------------------------------------
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    difficulty: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="medium"
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    question_text: Mapped[str] = mapped_column(Text, nullable=False)
    expected_signals: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    generated_by_ai: Mapped[bool] = mapped_column(
        nullable=False, server_default=sa.text("true")
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AIScreeningAnswer(Base):
    """Candidate answer — entered by recruiter or uploaded."""

    __tablename__ = "ai_screening_answers"

    id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        primary_key=True,
        server_default=sa.text("gen_random_uuid()"),
    )
    screening_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("ai_screenings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    question_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("ai_screening_questions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    answer_text: Mapped[str] = mapped_column(Text, nullable=False)
    recruiter_entered: Mapped[bool] = mapped_column(
        nullable=False, server_default=sa.text("true")
    )
    # manual | uploaded | link_response
    source_type: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="manual"
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=sa.text("now()"),
    )


class AIScreeningEvaluation(Base):
    """AI evaluation of a single answer — one row per question."""

    __tablename__ = "ai_screening_evaluations"

    id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        primary_key=True,
        server_default=sa.text("gen_random_uuid()"),
    )
    screening_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("ai_screenings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    question_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("ai_screening_questions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Per-answer scores (0–10) ------------------------------------------------
    ai_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    communication_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    technical_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Qualitative feedback ----------------------------------------------------
    strengths: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    concerns: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    reasoning: Mapped[str | None] = mapped_column(Text, nullable=True)
    follow_up_suggestion: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Confidence that the AI evaluation itself is accurate (0–100) -----------
    confidence: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=sa.text("now()"),
    )


class AIScreeningMessage(Base):
    """Single conversation turn in a live AI screening interview.

    role: 'interviewer' (AI question) | 'candidate' (transcribed answer) | 'system'
    """

    __tablename__ = "ai_screening_messages"

    id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        primary_key=True,
        server_default=sa.text("gen_random_uuid()"),
    )
    screening_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("ai_screenings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    role: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)

    sequence_number: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa.text("0"))
    question_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_followup: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa.text("false"))

    raw_transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    transcript_confidence: Mapped[float | None] = mapped_column(Numeric(4, 3), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
