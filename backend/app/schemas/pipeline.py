from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


_PIPELINE_STAGE_ALIASES: dict[str, str] = {
    # Legacy / migrated DB value -> canonical API enum value
    "screening": "ai_interview",
}


def _normalize_pipeline_stage_value(value: object) -> object:
    if isinstance(value, str):
        normalized = value.strip().lower()
        return _PIPELINE_STAGE_ALIASES.get(normalized, normalized)
    return value


class PipelineStage(StrEnum):
    APPLIED = "applied"
    AI_INTERVIEW = "ai_interview"
    INTERVIEW = "interview"
    OFFER = "offer"
    PLACED = "placed"
    REJECTED = "rejected"


class PipelineStatus(StrEnum):
    ACTIVE = "active"
    ON_HOLD = "on_hold"
    WITHDRAWN = "withdrawn"
    CLOSED = "closed"


# ── PIPE-004: Sorting ─────────────────────────────────────────────────────────

class PipelineSortBy(StrEnum):
    STAGE_UPDATED_AT = "stage_updated_at"
    CREATED_AT = "created_at"


class PipelineSortDir(StrEnum):
    ASC = "asc"
    DESC = "desc"


class PipelineCreate(BaseModel):
    candidate_id: UUID
    job_id: UUID
    stage: PipelineStage = PipelineStage.APPLIED
    status: PipelineStatus = PipelineStatus.ACTIVE
    notes: str | None = None

    @field_validator("stage", mode="before")
    @classmethod
    def normalize_stage(cls, value: object) -> object:
        return _normalize_pipeline_stage_value(value)


class PipelineUpdate(BaseModel):
    stage: PipelineStage | None = None
    status: PipelineStatus | None = None
    notes: str | None = None

    @field_validator("stage", mode="before")
    @classmethod
    def normalize_stage(cls, value: object) -> object:
        return _normalize_pipeline_stage_value(value)


class PipelineResponse(BaseModel):
    id: UUID
    organization_id: UUID
    candidate_id: UUID
    job_id: UUID
    stage: PipelineStage
    status: PipelineStatus
    notes: str | None
    stage_updated_at: datetime | None = None
    status_changed_at: datetime | None = None  # PIPE-003
    created_at: datetime
    updated_at: datetime

    # Denormalized job + client context — batch-loaded by the route layer.
    # These fields are always None on single-pipeline fetches; populated on list responses.
    job_title: str | None = None
    client_id: UUID | None = None
    client_name: str | None = None

    model_config = ConfigDict(from_attributes=True)

    @field_validator("stage", mode="before")
    @classmethod
    def normalize_stage(cls, value: object) -> object:
        return _normalize_pipeline_stage_value(value)


# ── PIPE-004: Paginated list response ─────────────────────────────────────────

class PipelineListMeta(BaseModel):
    """Pagination + aggregate metadata for `GET /pipelines`."""

    total: int = Field(..., description="Total number of matching pipelines (before pagination).")
    limit: int
    offset: int
    stage_counts: dict[str, int] = Field(
        default_factory=dict,
        description=(
            "Count of pipelines per stage across the full filtered set "
            "(excludes the stage filter itself so callers can see all stage distribution)."
        ),
    )


class PipelineListResponse(BaseModel):
    """Paginated pipeline list with aggregate metadata."""

    data: list[PipelineResponse]
    meta: PipelineListMeta


class PipelineStageTransitionRequest(BaseModel):
    """Payload for a controlled stage transition (PIPE-002)."""

    stage: PipelineStage
    reason: str | None = None

    @field_validator("stage", mode="before")
    @classmethod
    def normalize_stage(cls, value: object) -> object:
        return _normalize_pipeline_stage_value(value)

    @model_validator(mode="after")
    def validate_rejection_reason(self) -> "PipelineStageTransitionRequest":
        if self.stage == PipelineStage.REJECTED:
            if not self.reason or len(self.reason.strip()) < 10:
                raise ValueError(
                    "A rejection reason of at least 10 characters is required when rejecting a candidate."
                )
        return self


class PipelineStageHistoryResponse(BaseModel):
    """One row in the stage-transition audit log."""

    id: UUID
    pipeline_id: UUID
    organization_id: UUID
    previous_stage: str | None
    new_stage: str
    actor_user_id: UUID | None
    reason: str | None
    transitioned_at: datetime
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ── PIPE-003: Status tracking schemas ────────────────────────────────────────

class PipelineStatusChangeRequest(BaseModel):
    """Payload for a deliberate pipeline status change."""

    status: PipelineStatus
    reason: str | None = Field(default=None, description="Optional reason for the status change.")

    @model_validator(mode="after")
    def validate_withdraw_reason(self) -> "PipelineStatusChangeRequest":
        if self.status == PipelineStatus.WITHDRAWN:
            if not self.reason or len(self.reason.strip()) < 5:
                raise ValueError(
                    "A withdrawal reason of at least 5 characters is required."
                )
        return self


class WithdrawPipelineRequest(BaseModel):
    """Payload for the dedicated withdraw endpoint."""

    reason: str = Field(..., min_length=5, description="Reason for withdrawal (≥ 5 characters).")


class PipelineStatusHistoryResponse(BaseModel):
    """One row in the status-change audit log (PIPE-003)."""

    id: UUID
    pipeline_id: UUID
    organization_id: UUID
    previous_status: str | None
    new_status: str
    actor_user_id: UUID | None
    reason: str | None
    changed_at: datetime
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
