from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class JobParseResponse(BaseModel):
    """Response model for POST /jobs/parse-jd — fields extracted by Groq from a JD."""
    title: str | None = None
    location: str | None = None
    employment_type: str | None = None
    experience_min_years: int | None = None
    experience_max_years: int | None = None
    salary_min: int | None = None
    salary_max: int | None = None
    salary_currency: str = "USD"
    urgency: str = "normal"
    description: str | None = None
    required_skills: list[str] = []
    preferred_skills: list[str] = []
    key_responsibilities: list[str] = []
    # The raw source text (from paste or extracted from PDF) stored for "Raw JD" view.
    raw_jd_text: str | None = None



class JobStatus(StrEnum):
    DRAFT = "draft"
    OPEN = "open"
    PAUSED = "paused"
    CLOSED = "closed"
    FILLED = "filled"


class JobSubmissionStatus(StrEnum):
    PENDING = "pending"
    SHORTLISTED = "shortlisted"
    REJECTED = "rejected"
    INTERVIEWING = "interviewing"
    OFFERED = "offered"
    HIRED = "hired"


# ── PIPE-005: Submission Tracking enums ───────────────────────────────────────

class SubmissionOutcome(StrEnum):
    """Client decision on a submission."""
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class VendorSubmissionStatus(StrEnum):
    """Vendor-facing submission status — derived from outcome + submission_status."""
    SUBMITTED = "submitted"
    UNDER_REVIEW = "under_review"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


def derive_vendor_status(
    submission_status: str,
    outcome: str,
) -> VendorSubmissionStatus:
    """Compute the vendor-visible status from the recruiter-side fields."""
    if outcome == SubmissionOutcome.ACCEPTED:
        return VendorSubmissionStatus.ACCEPTED
    if outcome == SubmissionOutcome.REJECTED:
        return VendorSubmissionStatus.REJECTED
    # outcome == pending
    if submission_status in (
        JobSubmissionStatus.SHORTLISTED,
        JobSubmissionStatus.INTERVIEWING,
        JobSubmissionStatus.OFFERED,
    ):
        return VendorSubmissionStatus.UNDER_REVIEW
    return VendorSubmissionStatus.SUBMITTED


class JobCreate(BaseModel):
    """When client_id is omitted, the service assigns the organization default client."""
    client_id: UUID | str | None = None
    title: str = Field(min_length=1, max_length=255)
    description: str | None = None
    status: JobStatus = JobStatus.OPEN

    # Optional Phase 1 fields (kept optional so current frontend payloads work).
    location: str | None = None
    salary_min: float | None = None
    salary_max: float | None = None
    salary_currency: str | None = "USD"
    experience_min_years: int | None = None
    experience_max_years: int | None = None
    employment_type: str | None = None
    urgency: str | None = "standard"

    required_skills: list[str] | None = None
    preferred_skills: list[str] | None = None
    key_responsibilities: list[str] | None = None

    # Parsing metadata
    raw_jd_text: str | None = None
    parsing_source: str | None = None
    parsing_status: str | None = None


class JobUpdate(BaseModel):
    client_id: UUID | None = None
    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    status: JobStatus | None = None

    # Optional Phase 1 fields.
    location: str | None = None
    salary_min: float | None = None
    salary_max: float | None = None
    salary_currency: str | None = None
    experience_min_years: int | None = None
    experience_max_years: int | None = None
    employment_type: str | None = None
    urgency: str | None = None

    required_skills: list[str] | None = None
    preferred_skills: list[str] | None = None
    key_responsibilities: list[str] | None = None

    raw_jd_text: str | None = None
    parsing_source: str | None = None
    parsing_status: str | None = None


class JobStatusTransition(BaseModel):
    status: JobStatus
    reason: str | None = None


class JobSubmissionCreate(BaseModel):
    candidate_id: UUID
    notes: str | None = None


class JobSubmissionStatusUpdate(BaseModel):
    """Payload for PATCH /jobs/{job_id}/submissions/{submission_id} (Task 7)."""
    status: JobSubmissionStatus


class SubmissionOutcomeUpdate(BaseModel):
    """PIPE-005: Update outcome + optional client feedback."""
    outcome: SubmissionOutcome
    client_feedback: str | None = Field(
        default=None,
        description="Free-text feedback from the client.",
    )


class ClientFeedbackUpdate(BaseModel):
    """PIPE-005: Update client feedback independently of outcome."""
    client_feedback: str = Field(..., min_length=1)


class JobSubmissionResponse(BaseModel):
    id: UUID
    job_id: UUID
    candidate_id: UUID
    submission_status: JobSubmissionStatus
    submitted_at: datetime
    submitted_by: UUID
    notes: str | None
    # PIPE-005 fields
    vendor_id: UUID | None = None
    outcome: SubmissionOutcome = SubmissionOutcome.PENDING
    client_feedback: str | None = None
    vendor_status: VendorSubmissionStatus | None = None

    model_config = ConfigDict(from_attributes=True)

    @model_validator(mode="after")
    def _compute_vendor_status(self) -> "JobSubmissionResponse":
        """Derive vendor_status after all fields are populated."""
        self.vendor_status = derive_vendor_status(
            str(self.submission_status),
            str(self.outcome),
        )
        return self


class VendorSubmissionResponse(BaseModel):
    """PIPE-005: Vendor-facing submission row (no cross-vendor data exposed)."""
    id: UUID
    job_id: UUID
    candidate_id: UUID
    submitted_at: datetime
    outcome: SubmissionOutcome = SubmissionOutcome.PENDING
    vendor_status: VendorSubmissionStatus | None = None
    client_feedback: str | None = None  # shown only when outcome is final
    notes: str | None = None
    # Internal: read from ORM to derive vendor_status, excluded from serialised output.
    submission_status: JobSubmissionStatus = Field(
        default=JobSubmissionStatus.PENDING,
        exclude=True,
    )

    model_config = ConfigDict(from_attributes=True)

    @model_validator(mode="after")
    def _compute_vendor_fields(self) -> "VendorSubmissionResponse":
        """Derive vendor_status and gate client_feedback after all fields are read."""
        self.vendor_status = derive_vendor_status(
            str(self.submission_status),
            str(self.outcome),
        )
        # Only expose client feedback when a final outcome has been set.
        if self.outcome == SubmissionOutcome.PENDING:
            self.client_feedback = None
        return self


class HybridScoreBreakdown(BaseModel):
    """Persisted under category_scores.hybrid JSON (deterministic + semantic blend)."""

    model_config = ConfigDict(extra="ignore")

    deterministic_score: int | float | None = None
    semantic_score: int | float | None = None
    final_score: int | float | None = None
    weights: dict[str, float] | None = None


class JobMatchCategoryScores(BaseModel):
    required_skills: int
    preferred_skills: int
    experience: int
    title: int
    education: int
    # v2 weight categories (None for legacy records scored before this version)
    communication: int | None = None
    culture: int | None = None
    breadth: int | None = None
    hybrid: HybridScoreBreakdown | None = None
    # v2 debug fields stored in category_scores JSONB for transparency panel
    skill_match_log: list[dict] | None = None
    score_explanation: str | None = None


class JobMatchEntry(BaseModel):
    """fit_score is hybrid (70% deterministic + 30% semantic when AI succeeds)."""

    rank: int
    candidate_id: UUID
    candidate_name: str | None = None
    fit_score: int
    deterministic_match_score: int | None = None
    semantic_match_score: int | None = None
    ai_enrichment_status: str | None = None
    ats_pipeline_status: str | None = None
    enrichment_started_at: datetime | None = None
    deterministic_completed_at: datetime | None = None
    semantic_completed_at: datetime | None = None
    enrichment_error: str | None = None
    recruiter_summary: str | None = None
    confidence_reasoning: str | None = None
    semantic_skill_matches: list[str] = Field(default_factory=list)
    transferable_skills: list[str] = Field(default_factory=list)
    inferred_strengths: list[str] = Field(default_factory=list)
    inferred_gaps: list[str] = Field(default_factory=list)
    category_scores: JobMatchCategoryScores
    already_submitted: bool
    matched_skills: list[str] = Field(default_factory=list)
    missing_skills: list[str] = Field(default_factory=list)
    recommendation: str = "Weak Match"
    confidence_score: float = 0.0
    evaluated_at: datetime | None = None


class JobMatchTriggerRequest(BaseModel):
    refresh: bool = False


class JobMatchTriggerResponse(BaseModel):
    job_id: UUID
    match_count: int
    generated_at: datetime
    refresh_requested: bool
    semantic_enrichment: str | None = None
    """queued | disabled | none — background semantic pipeline after fast deterministic write."""


class AtsCandidateRescoreResponse(BaseModel):
    status: str
    candidate_id: UUID
    pairs_scored: int
    semantic_enrichment: str
    """queued | disabled | none | inline_full (sync=true full pipeline)."""

    mode: str = "fast"
    """fast (deterministic + async semantic) or full_sync."""


class AtsPairStatusResponse(BaseModel):
    candidate_id: UUID
    job_id: UUID
    processing_state: str
    progress: int = 0
    last_updated: datetime | None = None
    deterministic_score: int | None = None
    semantic_score: int | None = None
    final_score: int | None = None
    semantic_completion_status: str | None = None
    enrichment_error: str | None = None
    enqueue_delay_ms: int | None = None


class JobMatchesResponse(BaseModel):
    job_id: UUID
    matches: list[JobMatchEntry]
    total_count: int
    generated_at: datetime
    limit: int
    offset: int


class CandidateMatchEntry(BaseModel):
    job_id: UUID
    job_title: str | None = None
    fit_score: int
    deterministic_match_score: int | None = None
    semantic_match_score: int | None = None
    ai_enrichment_status: str | None = None
    ats_pipeline_status: str | None = None
    enrichment_started_at: datetime | None = None
    deterministic_completed_at: datetime | None = None
    semantic_completed_at: datetime | None = None
    enrichment_error: str | None = None
    recruiter_summary: str | None = None
    confidence_reasoning: str | None = None
    semantic_skill_matches: list[str] = Field(default_factory=list)
    transferable_skills: list[str] = Field(default_factory=list)
    inferred_strengths: list[str] = Field(default_factory=list)
    inferred_gaps: list[str] = Field(default_factory=list)
    category_scores: JobMatchCategoryScores
    matched_skills: list[str] = Field(default_factory=list)
    missing_skills: list[str] = Field(default_factory=list)
    recommendation: str = "Weak Match"
    confidence_score: float = 0.0
    evaluated_at: datetime | None = None


class CandidateMatchesResponse(BaseModel):
    candidate_id: UUID
    matches: list[CandidateMatchEntry]
    total_count: int
    limit: int
    offset: int
    pipeline_job_count: int = 0
    """Number of pipeline rows for this candidate in the org (applied jobs)."""

    ats_hint: str | None = None
    """UI hint when matches are empty: NO_PIPELINE_JOBS | NO_SCORE_ROWS_YET."""


class JobResponse(BaseModel):
    """Full job representation returned by GET /jobs and GET /jobs/{id}."""

    id: UUID
    organization_id: UUID
    client_id: UUID | None = None
    client_name: str | None = None  # Joined from clients table — never null in practice
    title: str
    description: str | None
    status: JobStatus | str  # permissive on output; strict validation is on input schemas
    paused_reason: str | None = None

    # Rich spec fields (Task 1 – previously missing from API response).
    location: str | None = None
    salary_min: float | None = None
    salary_max: float | None = None
    salary_currency: str | None = None
    experience_min_years: int | None = None
    experience_max_years: int | None = None
    employment_type: str | None = None
    urgency: str | None = None
    created_by: UUID | None = None
    filled_at: datetime | None = None

    # Embedded skills from job_skills table (Task 4 – pre-fills edit form).
    required_skills: list[str] = Field(default_factory=list)
    preferred_skills: list[str] = Field(default_factory=list)
    key_responsibilities: list[str] = Field(default_factory=list)

    # Parsing metadata
    raw_jd_text: str | None = None
    parsing_source: str | None = None
    parsing_status: str | None = None
    enrichment_status: str | None = None

    # Original JD binary (PDF/DOCX/TXT) — API exposes filename + availability only.
    jd_file_name: str | None = None
    jd_original_available: bool = False

    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
