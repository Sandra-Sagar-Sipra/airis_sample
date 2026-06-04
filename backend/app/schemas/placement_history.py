from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class PlacementOutcome(StrEnum):
    """Stored in candidate_placement_history.outcome — includes pipeline stages."""

    PENDING = "pending"
    APPLIED = "applied"
    AI_INTERVIEW = "ai_interview"
    INTERVIEW = "interview"
    OFFER = "offer"
    PLACED = "placed"
    REJECTED = "rejected"


class CandidatePlacementResponse(BaseModel):
    """Read-only placement history row for GET /candidates/{id}/placements."""

    id: UUID
    candidate_id: UUID
    job_id: UUID
    job_title: str
    outcome: PlacementOutcome
    placement_date: datetime
    created_at: datetime
    rejection_reason: str | None = Field(
        default=None,
        description="Recruiter note when outcome is rejected (from pipeline stage history).",
    )

    model_config = ConfigDict(from_attributes=True)


class CandidatePlacementListResponse(BaseModel):
    data: list[CandidatePlacementResponse] = Field(default_factory=list)
    total: int = 0
