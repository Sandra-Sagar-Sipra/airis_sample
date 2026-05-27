"""AI-004: Add AI summary columns to interviews table.

Adds four columns to support structured AI-generated interview summaries:
  - ai_summary       JSONB  — the generated summary payload
  - ai_summary_generated_at  TIMESTAMPTZ — when it was generated
  - ai_summary_provider      VARCHAR(64)  — which AI provider produced it
  - ai_summary_edited        BOOLEAN      — whether a recruiter has edited it

Revision ID: 20260525_0001
Revises: 20260522_0002
Create Date: 2026-05-25
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "20260525_0001"
down_revision = "20260522_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # Guard — skip if already applied (e.g. re-run on partially-migrated DB)
    existing_cols = {c["name"] for c in insp.get_columns("interviews")}

    if "ai_summary" not in existing_cols:
        op.add_column(
            "interviews",
            sa.Column("ai_summary", JSONB, nullable=True),
        )

    if "ai_summary_generated_at" not in existing_cols:
        op.add_column(
            "interviews",
            sa.Column(
                "ai_summary_generated_at",
                sa.DateTime(timezone=True),
                nullable=True,
            ),
        )

    if "ai_summary_provider" not in existing_cols:
        op.add_column(
            "interviews",
            sa.Column("ai_summary_provider", sa.String(64), nullable=True),
        )

    if "ai_summary_edited" not in existing_cols:
        op.add_column(
            "interviews",
            sa.Column(
                "ai_summary_edited",
                sa.Boolean,
                nullable=False,
                server_default=sa.text("false"),
            ),
        )


def downgrade() -> None:
    for col in ("ai_summary_edited", "ai_summary_provider", "ai_summary_generated_at", "ai_summary"):
        op.drop_column("interviews", col)
