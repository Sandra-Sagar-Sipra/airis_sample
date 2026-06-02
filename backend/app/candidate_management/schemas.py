from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Generic, TypeVar
from uuid import UUID

from pydantic import AliasChoices, BaseModel, ConfigDict, EmailStr, Field, field_validator


T = TypeVar("T")


class CandidateSourceSchema(str, Enum):
    MANUAL = "manual"
    RESUME_UPLOAD = "resume_upload"
    BULK_UPLOAD = "bulk_upload"
    REFERRAL = "referral"
    AGENCY = "agency"
    IMPORT = "import"
    MERGE = "merge"


class CandidateStatusSchema(str, Enum):
    ACTIVE = "active"
    ARCHIVED = "archived"
    DELETED = "deleted"


class CandidateStageSchema(str, Enum):
    APPLIED = "applied"
    AI_INTERVIEW = "ai_interview"
    SHORTLISTED = "shortlisted"
    INTERVIEW = "interview"
    OFFERED = "offered"
    HIRED = "hired"
    REJECTED = "rejected"


class InteractionTypeSchema(str, Enum):
    NOTE = "note"
    EMAIL = "email"
    STAGE_CHANGE = "stage_change"
    INTERVIEW = "interview"
    CALL = "call"
    MEETING = "meeting"
    SYSTEM = "system"


class BulkUploadStatusSchema(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class BulkUploadItemStatusSchema(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED_DUPLICATE = "skipped_duplicate"


class ApiResponse(BaseModel, Generic[T]):
    success: bool
    data: T | None = None
    error: str | None = None
    details: dict[str, Any] | list[Any] | None = None


class CandidateSkillInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    proficiency: str | None = Field(default=None, max_length=30)
    years_experience: int | None = Field(default=None, ge=0)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    source: str | None = Field(default=None, max_length=40)

    model_config = ConfigDict(extra="forbid")


class CandidateCreate(BaseModel):
    first_name: str = Field(min_length=1, max_length=120)
    last_name: str = Field(min_length=1, max_length=120)
    full_name: str | None = Field(default=None, min_length=1, max_length=260)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, min_length=7, max_length=40)
    location: str | None = Field(default=None, max_length=255)
    years_experience: int | None = Field(default=None, ge=0)
    headline: str | None = Field(default=None, max_length=255)
    summary: str | None = None
    source: CandidateSourceSchema = CandidateSourceSchema.MANUAL
    stage: CandidateStageSchema = CandidateStageSchema.APPLIED
    recruiter_id: UUID | None = None
    resume_s3_key: str | None = Field(default=None, max_length=1024)
    resume_file_name: str | None = Field(default=None, max_length=512)
    parse_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    parsed_resume_data: dict[str, Any] | None = None
    skills: list[CandidateSkillInput] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, value: str | None) -> str | None:
        if value is None:
            return None
        allowed = set("0123456789+()-. ")
        if any(ch not in allowed for ch in value):
            raise ValueError("phone contains invalid characters")
        return value.strip()

    @field_validator("email", mode="before")
    @classmethod
    def sanitize_email(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            return None
        return value


class CandidateUpdate(BaseModel):
    first_name: str | None = Field(default=None, min_length=1, max_length=120)
    last_name: str | None = Field(default=None, min_length=1, max_length=120)
    full_name: str | None = Field(default=None, min_length=1, max_length=260)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, min_length=7, max_length=40)
    location: str | None = Field(default=None, max_length=255)
    years_experience: int | None = Field(default=None, ge=0)
    headline: str | None = Field(default=None, max_length=255)
    summary: str | None = None
    status: CandidateStatusSchema | None = None
    source: CandidateSourceSchema | None = None
    stage: CandidateStageSchema | None = None
    job_id: UUID | None = None
    recruiter_id: UUID | None = None
    parse_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    parsed_resume_data: dict[str, Any] | None = None
    skills: list[CandidateSkillInput] | None = None

    model_config = ConfigDict(extra="ignore")

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, value: str | None) -> str | None:
        if value is None:
            return None
        allowed = set("0123456789+()-. ")
        if any(ch not in allowed for ch in value):
            raise ValueError("phone contains invalid characters")
        return value.strip()

    @field_validator("email", mode="before")
    @classmethod
    def sanitize_email(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            return None
        return value


class CandidateSkillResponse(BaseModel):
    id: UUID
    name: str
    normalized_name: str
    proficiency: str | None
    years_experience: int | None
    confidence: float | None
    source: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class CandidateResponse(BaseModel):
    id: UUID
    org_id: UUID
    workspace_id: UUID
    first_name: str
    last_name: str
    full_name: str
    email: EmailStr | None
    phone: str | None
    location: str | None
    years_experience: int | None
    headline: str | None
    summary: str | None
    stage: CandidateStageSchema
    job_id: UUID | None
    recruiter_id: UUID | None
    source: CandidateSourceSchema
    status: CandidateStatusSchema
    resume_s3_key: str | None
    resume_file_name: str | None
    resume_uploaded_at: datetime | None
    ai_parse_version: str | None
    parse_confidence: float | None
    parsed_resume_data: dict[str, Any] | None
    parse_status: str | None = None
    parse_error: str | None = None
    parsed_at: datetime | None = None
    merged_into_candidate_id: UUID | None
    merged_at: datetime | None
    created_by: UUID | None
    updated_by: UUID | None
    deleted_by: UUID | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    skills: list[CandidateSkillResponse] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)

    @field_validator("email", mode="before")
    @classmethod
    def sanitize_email(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            return None
        return value

    @field_validator("stage", mode="before")
    @classmethod
    def sanitize_stage(cls, value: Any) -> str:
        if value is None:
            return "applied"
        val = str(value).strip().lower()
        if val == "shortlisted":
            return "ai_interview"
        valid_stages = {e.value for e in CandidateStageSchema}
        if val in valid_stages:
            return val
        return "applied"

    @field_validator("source", mode="before")
    @classmethod
    def sanitize_source(cls, value: Any) -> str:
        if value is None:
            return CandidateSourceSchema.MANUAL.value
        val = str(value).strip().lower()
        valid = {e.value for e in CandidateSourceSchema}
        return val if val in valid else CandidateSourceSchema.MANUAL.value

    @field_validator("status", mode="before")
    @classmethod
    def sanitize_status(cls, value: Any) -> str:
        if value is None:
            return CandidateStatusSchema.ACTIVE.value
        val = str(value).strip().lower()
        valid = {e.value for e in CandidateStatusSchema}
        return val if val in valid else CandidateStatusSchema.ACTIVE.value


class ResumeUploadRequest(BaseModel):
    candidate_id: UUID | None = None
    resume_s3_key: str = Field(min_length=1, max_length=1024)
    resume_file_name: str = Field(min_length=1, max_length=512)
    source: CandidateSourceSchema = CandidateSourceSchema.RESUME_UPLOAD

    model_config = ConfigDict(extra="forbid")


class ResumeParseResult(BaseModel):
    parsed_resume_data: dict[str, Any]
    parse_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    ai_parse_version: str | None = Field(default=None, max_length=64)
    extracted_skills: list[CandidateSkillInput] = Field(default_factory=list)

    # ATS-friendly structured fields produced by the local extractor.
    # All optional so existing AI fallback callers stay backward-compatible.
    years_of_experience: float | None = Field(default=None, ge=0.0, le=80.0)
    education: list[str] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)
    previous_titles: list[str] = Field(default_factory=list)
    normalized_keywords: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ResumeUploadResponse(BaseModel):
    candidate: CandidateResponse
    parse_result: ResumeParseResult
    resume_download_url: str | None = None

    model_config = ConfigDict(from_attributes=True)


class InteractionCreate(BaseModel):
    interaction_type: InteractionTypeSchema
    title: str | None = Field(default=None, max_length=255)
    body: str | None = None
    interaction_metadata: dict[str, Any] | None = None

    model_config = ConfigDict(extra="forbid")


class InteractionResponse(BaseModel):
    id: UUID
    candidate_id: UUID
    org_id: UUID
    workspace_id: UUID
    interaction_type: InteractionTypeSchema
    title: str | None
    body: str | None
    metadata: dict[str, Any] | None = Field(
        default=None,
        validation_alias=AliasChoices("interaction_metadata", "metadata"),
    )
    actor_user_id: UUID | None
    actor_role: str | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    @field_validator("metadata", mode="before")
    @classmethod
    def coerce_interaction_metadata(cls, value: Any) -> dict[str, Any] | None:
        if value is None:
            return None
        if isinstance(value, dict):
            return value
        return {"_legacy_wrapped": True, "value": value}

    @field_validator("title", "body", mode="before")
    @classmethod
    def coerce_optional_text(cls, value: Any) -> str | None:
        if value is None:
            return None
        if isinstance(value, str):
            return value
        return str(value)


class NoteCreate(BaseModel):
    """AIR-38 / AIR-507: Create a candidate note (stored as interaction type note)."""

    content: str = Field(min_length=1, max_length=8000)

    model_config = ConfigDict(extra="forbid")

    @field_validator("content")
    @classmethod
    def strip_non_empty_content(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("content cannot be empty or whitespace only")
        return stripped


class NoteResponse(BaseModel):
    """AIR-38: Note row for timeline UI."""

    id: UUID
    candidate_id: UUID
    content: str
    author_user_id: UUID | None
    author_email: str | None = None
    author_role: str | None = None
    created_at: datetime
    hidden: bool = False

    model_config = ConfigDict(from_attributes=True)


class NoteListResponse(BaseModel):
    data: list[NoteResponse] = Field(default_factory=list)
    total: int = 0


class MergeCandidatesRequest(BaseModel):
    source_candidate_id: UUID
    target_candidate_id: UUID
    merge_reason: str | None = Field(default=None, max_length=255)
    keep_target_resume: bool = True

    model_config = ConfigDict(extra="forbid")


class BulkUploadRequest(BaseModel):
    files: list[str] = Field(min_length=1, description="List of resume S3 keys to process")
    source: CandidateSourceSchema = CandidateSourceSchema.IMPORT

    model_config = ConfigDict(extra="forbid")

    @field_validator("files")
    @classmethod
    def validate_files(cls, value: list[str]) -> list[str]:
        cleaned = [item.strip() for item in value if item and item.strip()]
        if not cleaned:
            raise ValueError("at least one non-empty file key is required")
        return cleaned


class BulkUploadItemStatusResponse(BaseModel):
    id: UUID
    job_id: UUID
    candidate_id: UUID | None
    row_number: int | None
    original_file_name: str | None
    resume_s3_key: str | None
    status: BulkUploadItemStatusSchema
    extracted_email: EmailStr | None
    extracted_phone: str | None
    ai_confidence: float | None
    error_message: str | None
    details: dict[str, Any] | None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)

    @field_validator("extracted_email", mode="before")
    @classmethod
    def sanitize_email(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            return None
        return value


class BulkUploadStatusResponse(BaseModel):
    id: UUID
    org_id: UUID
    workspace_id: UUID
    status: BulkUploadStatusSchema
    requested_by: UUID | None
    total_items: int
    processed_items: int
    success_items: int
    failed_items: int
    skipped_items: int
    error_summary: str | None
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime
    updated_at: datetime
    items: list[BulkUploadItemStatusResponse] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class CandidateBulkStageUpdateRequest(BaseModel):
    candidate_ids: list[str] = Field(min_length=1, max_length=500)
    stage: CandidateStageSchema

    model_config = ConfigDict(extra="forbid")


class BulkStageUpdateResponse(BaseModel):
    updated_count: int

    model_config = ConfigDict(extra="forbid")


class CandidateBulkDeleteRequest(BaseModel):
    candidate_ids: list[UUID] = Field(min_length=1)

    model_config = ConfigDict(extra="forbid")


class CandidateBulkAssignRecruiterRequest(BaseModel):
    candidate_ids: list[UUID] = Field(min_length=1)
    recruiter_id: UUID

    model_config = ConfigDict(extra="forbid")


class CandidateAssignRecruiterRequest(BaseModel):
    recruiter_id: UUID

    model_config = ConfigDict(extra="forbid")

