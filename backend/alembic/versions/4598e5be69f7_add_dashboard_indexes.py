"""add_dashboard_indexes

Revision ID: 4598e5be69f7
Revises: df1b27d06925
Create Date: 2026-06-01 13:19:03.507829
"""
from collections.abc import Sequence

from alembic import op
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = '4598e5be69f7'
down_revision: str | None = 'df1b27d06925'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _index_names(table: str) -> set[str]:
    return {idx["name"] for idx in inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    candidates_idx = _index_names("candidates")
    jobs_idx = _index_names("jobs")
    pipelines_idx = _index_names("pipelines")

    if "ix_candidates_created_at" not in candidates_idx:
        op.create_index("ix_candidates_created_at", "candidates", ["created_at"], unique=False)
    if "ix_jobs_created_at" not in jobs_idx:
        op.create_index("ix_jobs_created_at", "jobs", ["created_at"], unique=False)
    if "ix_pipelines_created_at" not in pipelines_idx:
        op.create_index("ix_pipelines_created_at", "pipelines", ["created_at"], unique=False)
    if "ix_pipelines_org_updated" not in pipelines_idx:
        op.create_index("ix_pipelines_org_updated", "pipelines", ["organization_id", "updated_at"], unique=False)


def downgrade() -> None:
    candidates_idx = _index_names("candidates")
    jobs_idx = _index_names("jobs")
    pipelines_idx = _index_names("pipelines")

    if "ix_pipelines_org_updated" in pipelines_idx:
        op.drop_index("ix_pipelines_org_updated", table_name="pipelines")
    if "ix_pipelines_created_at" in pipelines_idx:
        op.drop_index("ix_pipelines_created_at", table_name="pipelines")
    if "ix_jobs_created_at" in jobs_idx:
        op.drop_index("ix_jobs_created_at", table_name="jobs")
    if "ix_candidates_created_at" in candidates_idx:
        op.drop_index("ix_candidates_created_at", table_name="candidates")
