"""Add candidate_questions field to ai_screenings.

Revision ID: 20260602_0004
Revises: 20260602_0003
Create Date: 2026-06-02
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260602_0004"
down_revision: str | None = "f40facf26557"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _schema() -> str | None:
    from app.core.config import get_settings
    return get_settings().db_schema


def upgrade() -> None:
    schema = _schema()
    with op.batch_alter_table("ai_screenings", schema=schema) as batch:
        batch.add_column(sa.Column("candidate_questions", sa.Text, nullable=True))


def downgrade() -> None:
    schema = _schema()
    with op.batch_alter_table("ai_screenings", schema=schema) as batch:
        batch.drop_column("candidate_questions")
