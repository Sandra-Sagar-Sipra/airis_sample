"""AI Screening invite + video fields.

Adds expiry, invite config, video/audio storage, and leadership score to ai_screenings.

Revision ID: 20260602_0002
Revises: 20260602_0001, 4598e5be69f7
Create Date: 2026-06-02
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260602_0002"
down_revision: str | tuple = ("20260602_0001", "4598e5be69f7")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _schema() -> str | None:
    from app.core.config import get_settings
    return get_settings().db_schema


def upgrade() -> None:
    schema = _schema()
    with op.batch_alter_table("ai_screenings", schema=schema) as batch:
        batch.add_column(sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("max_questions", sa.Integer, nullable=True, server_default="12"))
        batch.add_column(sa.Column("interview_duration_minutes", sa.Integer, nullable=True, server_default="20"))
        batch.add_column(sa.Column("custom_instructions", sa.Text, nullable=True))
        batch.add_column(sa.Column("invitation_sent_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("invitation_email", sa.String(255), nullable=True))
        batch.add_column(sa.Column("video_url", sa.String(500), nullable=True))
        batch.add_column(sa.Column("audio_url", sa.String(500), nullable=True))
        batch.add_column(sa.Column("leadership_score", sa.Numeric(5, 2), nullable=True))


def downgrade() -> None:
    schema = _schema()
    with op.batch_alter_table("ai_screenings", schema=schema) as batch:
        batch.drop_column("leadership_score")
        batch.drop_column("audio_url")
        batch.drop_column("video_url")
        batch.drop_column("invitation_email")
        batch.drop_column("invitation_sent_at")
        batch.drop_column("custom_instructions")
        batch.drop_column("interview_duration_minutes")
        batch.drop_column("max_questions")
        batch.drop_column("expires_at")
