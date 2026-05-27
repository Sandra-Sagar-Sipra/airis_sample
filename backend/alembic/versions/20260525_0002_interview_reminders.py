"""SCHED-006: Create interview_reminders table.

Tracks the lifecycle of each scheduled reminder (24h / 1h) per recipient
so the sweep task can deduplicate and log send status.

Revision ID: 20260525_0002
Revises: 20260525_0001
Create Date: 2026-05-25
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID as PGUUID

revision = "20260525_0002"
down_revision = "20260525_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if "interview_reminders" in insp.get_table_names():
        return  # idempotent

    op.create_table(
        "interview_reminders",
        sa.Column(
            "id",
            PGUUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "interview_id",
            PGUUID(as_uuid=True),
            sa.ForeignKey("interviews.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("organization_id", PGUUID(as_uuid=True), nullable=False),
        sa.Column("reminder_type", sa.String(8), nullable=False),
        sa.Column("recipient_type", sa.String(16), nullable=False),
        sa.Column("recipient_email", sa.String(255), nullable=False),
        sa.Column(
            "scheduled_for",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.String(16),
            nullable=False,
            server_default=sa.text("'scheduled'"),
        ),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_reason", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    op.create_index("ix_interview_reminders_interview_id", "interview_reminders", ["interview_id"])
    op.create_index("ix_interview_reminders_organization_id", "interview_reminders", ["organization_id"])
    op.create_index("ix_interview_reminders_scheduled_for", "interview_reminders", ["scheduled_for"])
    op.create_index("ix_interview_reminders_status", "interview_reminders", ["status"])
    # Composite: sweep query — status + scheduled_for
    op.create_index(
        "ix_interview_reminders_status_scheduled_for",
        "interview_reminders",
        ["status", "scheduled_for"],
    )


def downgrade() -> None:
    op.drop_index("ix_interview_reminders_status_scheduled_for", table_name="interview_reminders")
    op.drop_index("ix_interview_reminders_status", table_name="interview_reminders")
    op.drop_index("ix_interview_reminders_scheduled_for", table_name="interview_reminders")
    op.drop_index("ix_interview_reminders_organization_id", table_name="interview_reminders")
    op.drop_index("ix_interview_reminders_interview_id", table_name="interview_reminders")
    op.drop_table("interview_reminders")
