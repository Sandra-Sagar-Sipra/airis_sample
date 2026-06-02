"""F-INV-04: Add invite delivery-tracking columns.

Adds six columns to the invites table so the platform can record whether
each invitation email was successfully delivered and expose that data in
the admin UI:

  delivery_status          — pending | sent | failed (varchar 16, default 'pending')
  delivery_provider        — e.g. 'brevo_smtp'       (varchar 64, nullable)
  message_id               — email Message-ID header  (varchar 255, nullable)
  delivery_attempts        — cumulative send attempts (integer, default 0)
  last_delivery_attempt_at — timestamp of most recent attempt
  last_delivery_error      — truncated error text from latest failure

Revision ID: 20260601_0001
Revises: 20260528_0001, f37e0c3820aa
Create Date: 2026-06-01
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect


revision: str = "20260601_0001"
down_revision: tuple[str, str] = ("20260528_0001", "f37e0c3820aa")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _schema() -> str | None:
    from app.core.config import get_settings
    return get_settings().db_schema


def _column_names(schema: str | None) -> set[str]:
    inspector = inspect(op.get_bind())
    return {c["name"] for c in inspector.get_columns("invites", schema=schema)}


def upgrade() -> None:
    schema = _schema()
    cols = _column_names(schema)

    new_cols: list[tuple[str, sa.Column]] = [
        ("delivery_status",          sa.Column("delivery_status",          sa.String(16),  nullable=False, server_default=sa.text("'pending'"))),
        ("delivery_provider",        sa.Column("delivery_provider",        sa.String(64),  nullable=True)),
        ("message_id",               sa.Column("message_id",               sa.String(255), nullable=True)),
        ("delivery_attempts",        sa.Column("delivery_attempts",        sa.Integer(),   nullable=False, server_default=sa.text("0"))),
        ("last_delivery_attempt_at", sa.Column("last_delivery_attempt_at", sa.DateTime(timezone=True), nullable=True)),
        ("last_delivery_error",      sa.Column("last_delivery_error",      sa.String(500), nullable=True)),
    ]

    for col_name, col_def in new_cols:
        if col_name not in cols:
            op.add_column("invites", col_def, schema=schema)


def downgrade() -> None:
    schema = _schema()
    cols = _column_names(schema)

    for col_name in (
        "delivery_status",
        "delivery_provider",
        "message_id",
        "delivery_attempts",
        "last_delivery_attempt_at",
        "last_delivery_error",
    ):
        if col_name in cols:
            op.drop_column("invites", col_name, schema=schema)
