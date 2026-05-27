from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class InterviewStatus(StrEnum):
    SCHEDULED = "scheduled"
    PENDING_PANEL = "pending_panel"
    PANEL_CONFIRMED = "panel_confirmed"
    IN_PROGRESS = "in_progress"
    CONFIRMED = "confirmed"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    NO_SHOW = "no_show"
    RESCHEDULED = "rescheduled"
    FEEDBACK_PENDING = "feedback_pending"
    FEEDBACK_SUBMITTED = "feedback_submitted"


class InterviewType(StrEnum):
    HR = "hr"
    TECHNICAL = "technical"
    MANAGERIAL = "managerial"
    FINAL = "final"
    AI_SCREENING = "ai_screening"


class MeetingType(StrEnum):
    VIRTUAL = "virtual"
    IN_PERSON = "in_person"
    PHONE = "phone"
    HYBRID = "hybrid"


class ParticipantRole(StrEnum):
    LEAD = "lead"
    PANEL = "panel"
    OBSERVER = "observer"
    HIRING_MANAGER = "hiring_manager"


class ParticipantStatus(StrEnum):
    INVITED = "invited"
    ACCEPTED = "accepted"
    DECLINED = "declined"


class FeedbackRecommendation(StrEnum):
    STRONG_YES = "strong_yes"
    YES = "yes"
    NEUTRAL = "neutral"
    NO = "no"
    STRONG_NO = "strong_no"


# ── Interview CRUD ─────────────────────────────────────────────────────────

class InterviewCreate(BaseModel):
    pipeline_id: UUID
    interview_type: InterviewType | None = None
    meeting_type: MeetingType | None = None
    scheduled_at: datetime = Field(description="ISO 8601; stored as UTC.")
    duration_minutes: int | None = Field(default=None, ge=1, le=480)
    meeting_link: str | None = Field(default=None, max_length=512)
    location: str | None = Field(default=None, max_length=255)
    status: InterviewStatus = InterviewStatus.PENDING_PANEL
    interviewer_name: str | None = Field(default=None, max_length=255)
    notes: str | None = None

    @field_validator("scheduled_at")
    @classmethod
    def scheduled_at_to_utc(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            return v.replace(tzinfo=UTC)
        return v.astimezone(UTC)


class InterviewUpdate(BaseModel):
    pipeline_id: UUID | None = None
    interview_type: InterviewType | None = None
    meeting_type: MeetingType | None = None
    scheduled_at: datetime | None = Field(default=None, description="Normalized to UTC; must not be in the past.")
    duration_minutes: int | None = Field(default=None, ge=1, le=480)
    meeting_link: str | None = Field(default=None, max_length=512)
    location: str | None = Field(default=None, max_length=255)
    status: InterviewStatus | None = None
    interviewer_name: str | None = Field(default=None, max_length=255)
    notes: str | None = None

    @field_validator("scheduled_at")
    @classmethod
    def scheduled_at_to_utc(cls, v: datetime | None) -> datetime | None:
        if v is None:
            return None
        if v.tzinfo is None:
            return v.replace(tzinfo=UTC)
        return v.astimezone(UTC)


class InterviewResponse(BaseModel):
    id: UUID
    organization_id: UUID
    pipeline_id: UUID
    candidate_id: UUID | None
    job_id: UUID | None
    interview_type: str | None
    meeting_type: str | None
    meeting_provider: str | None
    scheduled_at: datetime
    duration_minutes: int | None
    meeting_link: str | None
    location: str | None
    status: str
    interviewer_name: str | None
    notes: str | None
    created_by: UUID | None
    started_at: datetime | None
    ended_at: datetime | None
    # AI-004: structured post-interview summary
    ai_summary: dict | None = None
    ai_summary_generated_at: datetime | None = None
    ai_summary_provider: str | None = None
    ai_summary_edited: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class QueueInterviewResponse(InterviewResponse):
    """Extended response used in the interview queue with joined candidate/job data."""
    candidate_first_name: str | None = None
    candidate_last_name: str | None = None
    job_title: str | None = None
    participant_count: int = 0


# ── Participants ───────────────────────────────────────────────────────────

class InterviewParticipantCreate(BaseModel):
    user_id: UUID
    participant_role: ParticipantRole = ParticipantRole.PANEL


class InterviewParticipantResponse(BaseModel):
    id: UUID
    interview_id: UUID
    user_id: UUID
    participant_role: str
    status: str
    joined_at: datetime | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ── Feedback ──────────────────────────────────────────────────────────────

class InterviewFeedbackCreate(BaseModel):
    technical_score: int | None = Field(default=None, ge=1, le=5)
    communication_score: int | None = Field(default=None, ge=1, le=5)
    problem_solving_score: int | None = Field(default=None, ge=1, le=5)
    culture_fit_score: int | None = Field(default=None, ge=1, le=5)
    system_design_score: int | None = Field(default=None, ge=1, le=5)
    leadership_score: int | None = Field(default=None, ge=1, le=5)
    rating: int | None = Field(default=None, ge=1, le=5)
    recommendation: FeedbackRecommendation | None = None
    strengths: str | None = None
    weaknesses: str | None = None
    notes: str | None = None


class InterviewFeedbackResponse(BaseModel):
    id: UUID
    interview_id: UUID
    reviewer_id: UUID
    technical_score: int | None
    communication_score: int | None
    problem_solving_score: int | None
    culture_fit_score: int | None
    system_design_score: int | None
    leadership_score: int | None
    rating: int | None
    recommendation: str | None
    strengths: str | None
    weaknesses: str | None
    notes: str | None
    submitted_at: datetime | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ── Notes ──────────────────────────────────────────────────────────────────

class NoteUpsert(BaseModel):
    section: str | None = Field(default=None, max_length=64)
    content: str
    finalized: bool = False


class NoteResponse(BaseModel):
    id: UUID
    interview_id: UUID
    interviewer_id: UUID
    section: str | None
    content: str
    autosaved_at: datetime | None
    finalized: bool
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ── Workspace ──────────────────────────────────────────────────────────────

class CandidateWorkspaceInfo(BaseModel):
    id: UUID
    first_name: str
    last_name: str
    email: str
    phone: str | None
    location: str | None
    experience_summary: str | None
    education: str | None
    notes: str | None

    model_config = ConfigDict(from_attributes=True)


class FeedbackSummary(BaseModel):
    count: int
    avg_technical: float | None
    avg_communication: float | None
    avg_problem_solving: float | None
    avg_culture_fit: float | None
    avg_system_design: float | None
    avg_leadership: float | None
    avg_overall: float | None
    recommendations: dict[str, int]


class WorkspaceResponse(BaseModel):
    interview: InterviewResponse
    candidate: CandidateWorkspaceInfo | None
    job_title: str | None
    participants: list[InterviewParticipantResponse]
    notes: list[NoteResponse]
    feedback_summary: FeedbackSummary | None
    my_feedback: InterviewFeedbackResponse | None


# ── Interviewer profiles ───────────────────────────────────────────────────

class InterviewerProfileCreate(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    department: str | None = Field(default=None, max_length=255)
    is_active: bool = True
    max_interviews_per_day: int | None = Field(default=None, ge=1, le=20)
    timezone: str | None = Field(default=None, max_length=64)
    bio: str | None = None
    skills: list[str] = []


class InterviewerProfileResponse(BaseModel):
    id: UUID
    organization_id: UUID
    user_id: UUID
    title: str | None
    department: str | None
    is_active: bool
    max_interviews_per_day: int | None
    timezone: str | None
    bio: str | None
    skills: list[str] = []
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AvailabilitySlotCreate(BaseModel):
    day_of_week: int = Field(ge=0, le=6, description="0=Monday … 6=Sunday")
    start_time: str = Field(description="HH:MM 24-hour")
    end_time: str = Field(description="HH:MM 24-hour")
    timezone: str | None = None


class AvailabilitySlotResponse(BaseModel):
    id: UUID
    interviewer_profile_id: UUID
    day_of_week: int
    start_time: str
    end_time: str
    timezone: str | None

    model_config = ConfigDict(from_attributes=True)


# ── Interview Reminders (SCHED-006) ───────────────────────────────────────

class InterviewReminderResponse(BaseModel):
    id: UUID
    interview_id: UUID
    reminder_type: str
    recipient_type: str
    recipient_email: str
    scheduled_for: datetime
    status: str
    sent_at: datetime | None
    failure_reason: str | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ── AI Summary (AI-004) ────────────────────────────────────────────────────

class AISummaryRecommendation(StrEnum):
    STRONGLY_RECOMMEND = "strongly_recommend"
    RECOMMEND = "recommend"
    NEUTRAL = "neutral"
    DO_NOT_RECOMMEND = "do_not_recommend"


class AISummaryUpdate(BaseModel):
    """Payload for recruiter edits to the AI-generated summary."""
    key_strengths: list[str] | None = Field(default=None, max_length=5)
    concerns: list[str] | None = Field(default=None, max_length=5)
    overall_assessment: str | None = None
    recommendation: AISummaryRecommendation | None = None
    reasoning: str | None = None


class AISummaryResponse(BaseModel):
    """Structured response returned from the summary endpoints."""
    interview_id: UUID
    ai_summary: dict | None
    ai_summary_generated_at: datetime | None
    ai_summary_provider: str | None
    ai_summary_edited: bool
