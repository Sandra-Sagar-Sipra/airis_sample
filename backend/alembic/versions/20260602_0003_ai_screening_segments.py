"""Add ai_screening_segments table for per-question recording data.

Revision ID: 20260602_0003
Revises: 20260602_0002
Create Date: 2026-06-02
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260602_0003"
down_revision: str | None = "20260602_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _schema() -> str | None:
    from app.core.config import get_settings
    return get_settings().db_schema


def upgrade() -> None:
    schema = _schema()
    op.create_table(
        "ai_screening_segments",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True),
                  server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("screening_id", sa.dialects.postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("ai_screenings.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("question_number", sa.Integer, nullable=False),
        sa.Column("question_text", sa.Text, nullable=False),
        sa.Column("transcript", sa.Text, nullable=True),
        # Seconds from interview start
        sa.Column("question_start_seconds", sa.Numeric(10, 3), nullable=True),
        sa.Column("answer_start_seconds", sa.Numeric(10, 3), nullable=True),
        sa.Column("answer_end_seconds", sa.Numeric(10, 3), nullable=True),
        sa.Column("duration_seconds", sa.Numeric(10, 3), nullable=True),
        # Supabase storage paths / signed URLs
        sa.Column("video_clip_url", sa.String(1000), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        schema=schema,
    )


def downgrade() -> None:
    op.drop_table("ai_screening_segments", schema=_schema())
