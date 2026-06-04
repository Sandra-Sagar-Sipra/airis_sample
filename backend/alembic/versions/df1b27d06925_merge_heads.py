"""merge_heads

Revision ID: df1b27d06925
Revises: 20260528_0001, f37e0c3820aa
Create Date: 2026-06-01 13:16:38.772246
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'df1b27d06925'
down_revision: str | None = ('20260528_0001', 'f37e0c3820aa')
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

