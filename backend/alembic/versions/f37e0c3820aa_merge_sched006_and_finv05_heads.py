"""merge_sched006_and_finv05_heads

Revision ID: f37e0c3820aa
Revises: 20260522_0001, 20260525_0002
Create Date: 2026-05-25 12:18:57.087847
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f37e0c3820aa'
down_revision: str | None = ('20260522_0001', '20260525_0002')
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

