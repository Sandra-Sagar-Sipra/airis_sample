"""Revision marker — already applied in this environment (restores Alembic graph).

Revision ID: f40facf26557
Revises: 20260602_0003
Create Date: 2026-06-03

No schema changes; upgrade/downgrade are no-ops so re-run is safe.
The live DB was stamped at this revision ID without a matching file in repo.
"""

from collections.abc import Sequence

revision: str = "f40facf26557"
down_revision: str | None = "20260602_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """No-op marker."""


def downgrade() -> None:
    """No-op marker."""
