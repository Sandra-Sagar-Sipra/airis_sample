"""Enhance ai_screenings for live interview mode.

Adds live-interview columns to ai_screenings, creates ai_screening_messages
table, and drops the now-superseded ai_interview_sessions / ai_interview_messages
tables (they were empty stubs from the short-lived separate module).

Revision ID: 20260601_0003
Revises: 20260601_0001
Create Date: 2026-06-01
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql

revision: str = "20260601_0003"
down_revision: str = "20260601_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _schema() -> str | None:
    from app.core.config import get_settings
    return get_settings().db_schema


def _col_names(schema: str | None) -> set[str]:
    return {c["name"] for c in inspect(op.get_bind()).get_columns("ai_screenings", schema=schema)}


def _table_names(schema: str | None) -> set[str]:
    return set(inspect(op.get_bind()).get_table_names(schema=schema))


def upgrade() -> None:
    schema = _schema()
    cols = _col_names(schema)
    tables = _table_names(schema)

    # ── New columns on ai_screenings ──────────────────────────────────────────
    additions = [
        ("interview_mode",          sa.Column("interview_mode", sa.String(32), nullable=False, server_default=sa.text("'async'"))),
        ("session_token",           sa.Column("session_token", sa.String(255), nullable=True)),
        ("livekit_room_name",       sa.Column("livekit_room_name", sa.String(255), nullable=True)),
        ("candidate_name_snapshot", sa.Column("candidate_name_snapshot", sa.String(255), nullable=True)),
        ("job_title_snapshot",      sa.Column("job_title_snapshot", sa.String(255), nullable=True)),
        ("started_at",              sa.Column("started_at", sa.DateTime(timezone=True), nullable=True)),
        ("ended_at",                sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True)),
        ("duration_seconds",        sa.Column("duration_seconds", sa.Integer, nullable=True)),
        ("experience_score",        sa.Column("experience_score", sa.Numeric(5, 2), nullable=True)),
        ("culture_fit_score",       sa.Column("culture_fit_score", sa.Numeric(5, 2), nullable=True)),
        ("salary_expectation",      sa.Column("salary_expectation", sa.String(255), nullable=True)),
        ("notice_period",           sa.Column("notice_period", sa.String(128), nullable=True)),
        ("career_goals",            sa.Column("career_goals", sa.Text, nullable=True)),
        ("key_projects_mentioned",  sa.Column("key_projects_mentioned", postgresql.JSONB, nullable=True)),
        ("strengths",               sa.Column("strengths", postgresql.JSONB, nullable=True)),
        ("concerns",                sa.Column("concerns", postgresql.JSONB, nullable=True)),
    ]
    for col_name, col_def in additions:
        if col_name not in cols:
            op.add_column("ai_screenings", col_def, schema=schema)

    # Unique constraint on session_token
    try:
        op.create_unique_constraint("uq_ai_screenings_session_token", "ai_screenings", ["session_token"], schema=schema)
    except Exception:
        pass  # Already exists

    # ── ai_screening_messages (live interview conversation turns) ─────────────
    if "ai_screening_messages" not in tables:
        op.create_table(
            "ai_screening_messages",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
            sa.Column("screening_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("ai_screenings.id", ondelete="CASCADE"), nullable=False),
            sa.Column("role", sa.String(32), nullable=False),
            sa.Column("content", sa.Text, nullable=False),
            sa.Column("sequence_number", sa.Integer, nullable=False, server_default=sa.text("0")),
            sa.Column("question_number", sa.Integer, nullable=True),
            sa.Column("is_followup", sa.Boolean, nullable=False, server_default=sa.text("false")),
            sa.Column("raw_transcript", sa.Text, nullable=True),
            sa.Column("transcript_confidence", sa.Numeric(4, 3), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
            schema=schema,
        )
        op.create_index("ix_ai_screening_messages_screening_id", "ai_screening_messages", ["screening_id"], schema=schema)

    # ── Drop superseded ai_interview_* tables ─────────────────────────────────
    for tbl in ["ai_interview_messages", "ai_interview_sessions"]:
        if tbl in tables:
            op.drop_table(tbl, schema=schema)


def downgrade() -> None:
    schema = _schema()
    # Drop ai_screening_messages
    op.drop_index("ix_ai_screening_messages_screening_id", table_name="ai_screening_messages", schema=schema)
    op.drop_table("ai_screening_messages", schema=schema)
    # Remove added columns
    for col in ["interview_mode","session_token","livekit_room_name","candidate_name_snapshot",
                "job_title_snapshot","started_at","ended_at","duration_seconds","experience_score",
                "culture_fit_score","salary_expectation","notice_period","career_goals",
                "key_projects_mentioned","strengths","concerns"]:
        op.drop_column("ai_screenings", col, schema=schema)
