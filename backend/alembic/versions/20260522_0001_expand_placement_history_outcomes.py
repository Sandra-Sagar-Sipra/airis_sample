"""Expand candidate_placement_history.outcome for pipeline stage timeline rows."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260522_0001"
down_revision = "20260521_0001"
branch_labels = None
depends_on = None

_OUTCOMES_SQL = (
    "'pending', 'placed', 'rejected', 'applied', 'screening', "
    "'ai_screening', 'interview', 'offer'"
)


def _table_exists(bind, table: str, schema: str | None) -> bool:
    insp = sa.inspect(bind)
    return table in insp.get_table_names(schema=schema)


def upgrade() -> None:
    bind = op.get_bind()
    schema = None
    if not _table_exists(bind, "candidate_placement_history", schema):
        return
    op.drop_constraint(
        "ck_candidate_placement_history_outcome",
        "candidate_placement_history",
        schema=schema,
        type_="check",
    )
    op.create_check_constraint(
        "ck_candidate_placement_history_outcome",
        "candidate_placement_history",
        f"outcome IN ({_OUTCOMES_SQL})",
        schema=schema,
    )


def downgrade() -> None:
    bind = op.get_bind()
    schema = None
    if not _table_exists(bind, "candidate_placement_history", schema):
        return
    op.drop_constraint(
        "ck_candidate_placement_history_outcome",
        "candidate_placement_history",
        schema=schema,
        type_="check",
    )
    op.create_check_constraint(
        "ck_candidate_placement_history_outcome",
        "candidate_placement_history",
        "outcome IN ('placed', 'rejected', 'pending')",
        schema=schema,
    )
