from __future__ import annotations

from datetime import datetime
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy import DateTime, event, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.exceptions.placement_history import ImmutablePlacementHistoryError

# Append-only placement history (AIR-37 / AIR-504).
# Application code must not UPDATE or DELETE rows; inserts only via PlacementHistoryService.
# DB ON DELETE CASCADE still removes rows when parent candidate/job is removed (GDPR hard delete).
PLACEMENT_OUTCOMES = frozenset(
    {
        "pending",
        "placed",
        "rejected",
        "applied",
        "ai_screening",
        "ai_interview",
        "interview",
        "offer",
    }
)

# Pipeline stages recorded on transition_stage (pending still comes from job submit).
TRACKED_PIPELINE_STAGE_OUTCOMES = frozenset(
    {
        "ai_screening",
        "ai_interview",
        "interview",
        "offer",
        "placed",
        "rejected",
    }
)


class CandidatePlacementHistory(Base):
    __tablename__ = "candidate_placement_history"
    __table_args__ = (
        sa.CheckConstraint(
            "outcome IN ('pending', 'placed', 'rejected', 'applied', "
            "'ai_screening', 'ai_interview', 'interview', 'offer')",
            name="ck_candidate_placement_history_outcome",
        ),
    )

    id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        primary_key=True,
        server_default=sa.text("gen_random_uuid()"),
    )
    candidate_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("candidates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    job_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("jobs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    outcome: Mapped[str] = mapped_column(String(20), nullable=False)
    placement_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


@event.listens_for(CandidatePlacementHistory, "before_update", propagate=True)
def _block_placement_history_update(_mapper, _connection, _target) -> None:
    raise ImmutablePlacementHistoryError(
        "candidate_placement_history rows cannot be updated (AIR-504)."
    )


@event.listens_for(CandidatePlacementHistory, "before_delete", propagate=True)
def _block_placement_history_delete(_mapper, _connection, _target) -> None:
    raise ImmutablePlacementHistoryError(
        "candidate_placement_history rows cannot be deleted via the ORM (AIR-504)."
    )
