"""Unify pipeline screening stages into ai_interview.

Revision ID: 20260602_0001
Revises: 20260601_0003
Create Date: 2026-06-02
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260602_0001"
down_revision: str | None = "20260601_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _schema() -> str | None:
    from app.core.config import get_settings

    return get_settings().db_schema


def _table(table_name: str, schema: str | None) -> str:
    if schema:
        return f'"{schema}"."{table_name}"'
    return f'"{table_name}"'


def upgrade() -> None:
    schema = _schema()
    pipelines = _table("pipelines", schema)
    stage_history = _table("pipeline_stage_history", schema)
    placement_history = _table("candidate_placement_history", schema)

    # 0) Allow outcome rewrite by relaxing check constraint first.
    op.drop_constraint(
        "ck_candidate_placement_history_outcome",
        "candidate_placement_history",
        schema=schema,
        type_="check",
    )
    op.create_check_constraint(
        "ck_candidate_placement_history_outcome",
        "candidate_placement_history",
        "outcome IN ('pending', 'placed', 'rejected', 'applied', 'screening', 'ai_screening', 'ai_interview', 'interview', 'offer')",
        schema=schema,
    )

    # 1) Collapse both legacy stages into a single canonical stage.
    op.execute(
        sa.text(
            f"""
            UPDATE {pipelines}
            SET stage = 'ai_interview'
            WHERE stage IN ('screening', 'ai_screening')
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            UPDATE {stage_history}
            SET previous_stage = 'ai_interview'
            WHERE previous_stage IN ('screening', 'ai_screening')
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            UPDATE {stage_history}
            SET new_stage = 'ai_interview'
            WHERE new_stage IN ('screening', 'ai_screening')
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            UPDATE {placement_history}
            SET outcome = 'ai_interview'
            WHERE outcome IN ('screening', 'ai_screening')
            """
        )
    )

    # 2) Align placement-history check constraint with the unified stage set.
    op.drop_constraint(
        "ck_candidate_placement_history_outcome",
        "candidate_placement_history",
        schema=schema,
        type_="check",
    )
    op.create_check_constraint(
        "ck_candidate_placement_history_outcome",
        "candidate_placement_history",
        "outcome IN ('pending', 'placed', 'rejected', 'applied', 'ai_interview', 'interview', 'offer')",
        schema=schema,
    )


def downgrade() -> None:
    schema = _schema()
    pipelines = _table("pipelines", schema)
    stage_history = _table("pipeline_stage_history", schema)
    placement_history = _table("candidate_placement_history", schema)

    # Revert canonical stage back to ai_screening.
    op.execute(
        sa.text(
            f"""
            UPDATE {pipelines}
            SET stage = 'ai_screening'
            WHERE stage = 'ai_interview'
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            UPDATE {stage_history}
            SET previous_stage = 'ai_screening'
            WHERE previous_stage = 'ai_interview'
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            UPDATE {stage_history}
            SET new_stage = 'ai_screening'
            WHERE new_stage = 'ai_interview'
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            UPDATE {placement_history}
            SET outcome = 'ai_screening'
            WHERE outcome = 'ai_interview'
            """
        )
    )

    op.drop_constraint(
        "ck_candidate_placement_history_outcome",
        "candidate_placement_history",
        schema=schema,
        type_="check",
    )
    op.create_check_constraint(
        "ck_candidate_placement_history_outcome",
        "candidate_placement_history",
        "outcome IN ('pending', 'placed', 'rejected', 'applied', 'screening', 'ai_screening', 'interview', 'offer')",
        schema=schema,
    )
