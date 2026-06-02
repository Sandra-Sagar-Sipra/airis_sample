"""Revision marker — already applied in some environments (restores Alembic graph).

Revision ID: 20260520_0004
Revises: 20260520_0003
Create Date: 2026-05-20

No schema changes; upgrade/downgrade are no-ops so re-run is safe.
"""
from __future__ import annotations

from collections.abc import Sequence

revision: str = "20260520_0004"
down_revision: str = "20260520_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
