"""Merge heads

Revision ID: fd3ea96c7e0c
Revises: 20260602_0001, 4598e5be69f7
Create Date: 2026-06-03 13:21:53.970215
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'fd3ea96c7e0c'
down_revision: str | None = ('20260602_0001', '4598e5be69f7')
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

