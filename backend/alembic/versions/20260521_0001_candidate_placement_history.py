"""AIR-502: Append-only candidate_placement_history table.

Revision ID: 20260521_0001
Revises: 20260520_0004
Create Date: 2026-05-21
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql

from app.core.config import get_settings

revision: str = "20260521_0001"
down_revision: str = "20260520_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _table_exists(connection, table_name: str) -> bool:
    schema = get_settings().db_schema or None
    inspector = inspect(connection)
    return inspector.has_table(table_name, schema=schema)


def upgrade() -> None:
    schema = get_settings().db_schema
    bind = op.get_bind()

    if _table_exists(bind, "candidate_placement_history"):
        return

    op.create_table(
        "candidate_placement_history",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "candidate_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("candidates.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "job_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("jobs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("outcome", sa.String(20), nullable=False),
        sa.Column("placement_date", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "outcome IN ('placed', 'rejected', 'pending')",
            name="ck_candidate_placement_history_outcome",
        ),
        schema=schema,
    )
    op.create_index(
        "ix_candidate_placement_history_candidate_id",
        "candidate_placement_history",
        ["candidate_id"],
        schema=schema,
    )
    op.create_index(
        "ix_candidate_placement_history_job_id",
        "candidate_placement_history",
        ["job_id"],
        schema=schema,
    )
    op.create_index(
        "ix_candidate_placement_history_candidate_placement_date",
        "candidate_placement_history",
        ["candidate_id", "placement_date"],
        schema=schema,
    )


def downgrade() -> None:
    schema = get_settings().db_schema
    bind = op.get_bind()

    if not _table_exists(bind, "candidate_placement_history"):
        return

    op.drop_index(
        "ix_candidate_placement_history_candidate_placement_date",
        table_name="candidate_placement_history",
        schema=schema,
    )
    op.drop_index(
        "ix_candidate_placement_history_job_id",
        table_name="candidate_placement_history",
        schema=schema,
    )
    op.drop_index(
        "ix_candidate_placement_history_candidate_id",
        table_name="candidate_placement_history",
        schema=schema,
    )
    op.drop_table("candidate_placement_history", schema=schema)
