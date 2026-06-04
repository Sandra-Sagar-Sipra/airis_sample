"""Add missing permissions to catalog

Revision ID: f40facf26557
Revises: fd3ea96c7e0c
Create Date: 2026-06-03 13:22:08.201980
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f40facf26557'
down_revision: str | None = 'fd3ea96c7e0c'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        INSERT INTO permissions (code, module, display_name) VALUES
        ('ai_screening:create', 'AI Screening', 'Create'),
        ('ai_screening:read', 'AI Screening', 'Read'),
        ('ai_screening:update', 'AI Screening', 'Update'),
        ('ai_screening:delete', 'AI Screening', 'Delete'),
        ('ai_screening:evaluate', 'AI Screening', 'Evaluate'),
        ('ai_interview_questions:generate', 'AI Interview Questions', 'Generate'),
        ('candidates:merge', 'Candidates', 'Merge'),
        ('candidates:read_own', 'Candidates', 'Read Own'),
        ('interviews:claim', 'Interviews', 'Claim'),
        ('interviews:copilot', 'Interviews', 'Copilot'),
        ('interviews:delete', 'Interviews', 'Delete'),
        ('interviews:feedback', 'Interviews', 'Feedback'),
        ('interviews:panel', 'Interviews', 'Panel'),
        ('jobs:read_limited', 'Jobs', 'Read Limited'),
        ('submissions:create', 'Submissions', 'Create'),
        ('submissions:read_own', 'Submissions', 'Read Own')
        ON CONFLICT (code) DO NOTHING;
    """)


def downgrade() -> None:
    op.execute("""
        DELETE FROM permissions WHERE code IN (
            'ai_screening:create', 'ai_screening:read', 'ai_screening:update', 
            'ai_screening:delete', 'ai_screening:evaluate', 'ai_interview_questions:generate',
            'candidates:merge', 'candidates:read_own', 'interviews:claim', 
            'interviews:copilot', 'interviews:delete', 'interviews:feedback', 
            'interviews:panel', 'jobs:read_limited', 'submissions:create', 'submissions:read_own'
        );
    """)

