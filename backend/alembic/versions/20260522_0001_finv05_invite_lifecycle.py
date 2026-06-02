"""F-INV-05: Invite lifecycle timestamps and expanded status values.

Adds sent_at, opened_at, accepted_at, expired_at columns to invites.
Expands the status check constraint to cover: sent, opened, accepted, expired.
Migrates existing rows: 'pending' → 'sent' (with sent_at = created_at).

Revision ID: 20260522_0001
Revises: 20260522_0003
Create Date: 2026-05-22
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect, text
from sqlalchemy.dialects import postgresql

revision: str = "20260522_0001"
down_revision: str = "20260522_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD_CHECK = "ck_invites_status_allowed"
_NEW_CHECK = "ck_invites_status_lifecycle"
_NEW_STATUSES = ("sent", "opened", "accepted", "expired")


def _schema() -> str | None:
    from app.core.config import get_settings

    return get_settings().db_schema


def _check_names(schema: str | None) -> set[str]:
    inspector = inspect(op.get_bind())
    return {c["name"] for c in inspector.get_check_constraints("invites", schema=schema)}


def _column_names(schema: str | None) -> set[str]:
    inspector = inspect(op.get_bind())
    return {c["name"] for c in inspector.get_columns("invites", schema=schema)}


def upgrade() -> None:
    schema = _schema()
    qualified = f"{schema}.invites" if schema else "invites"

    # 1. Drop old check constraint (only allowed 'pending', 'accepted')
    checks = _check_names(schema)
    if _OLD_CHECK in checks:
        op.drop_constraint(_OLD_CHECK, "invites", schema=schema, type_="check")

    # 2. Add timestamp columns (idempotent) — must exist before data migration
    cols = _column_names(schema)
    for col_name in ("sent_at", "opened_at", "accepted_at", "expired_at"):
        if col_name not in cols:
            op.add_column(
                "invites",
                sa.Column(col_name, sa.DateTime(timezone=True), nullable=True),
                schema=schema,
            )

    # 3. Data migration: pending → sent; backfill sent_at from created_at
    #    Must happen BEFORE adding the new check constraint so no rows violate it.
    op.execute(
        text(
            f"UPDATE {qualified} SET status = 'sent', sent_at = created_at"
            " WHERE status = 'pending'"
        )
    )

    # 4. Add new check constraint with full lifecycle statuses (after data is clean)
    if _NEW_CHECK not in _check_names(schema):
        op.create_check_constraint(
            _NEW_CHECK,
            "invites",
            f"status IN {_NEW_STATUSES}",
            schema=schema,
        )


def downgrade() -> None:
    schema = _schema()
    qualified = f"{schema}.invites" if schema else "invites"

    # Revert data: sent → pending
    op.execute(text(f"UPDATE {qualified} SET status = 'pending' WHERE status = 'sent'"))

    # Drop lifecycle check
    checks = _check_names(schema)
    if _NEW_CHECK in checks:
        op.drop_constraint(_NEW_CHECK, "invites", schema=schema, type_="check")

    # Restore old check constraint
    if _OLD_CHECK not in checks:
        op.create_check_constraint(
            _OLD_CHECK,
            "invites",
            "status IN ('pending', 'accepted')",
            schema=schema,
        )

    # Drop timestamp columns
    cols = _column_names(schema)
    for col_name in ("sent_at", "opened_at", "accepted_at", "expired_at"):
        if col_name in cols:
            op.drop_column("invites", col_name, schema=schema)
