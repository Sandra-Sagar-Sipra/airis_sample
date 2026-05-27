from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


# ── Enums ─────────────────────────────────────────────────────────────────────

class CopilotSessionStatus(StrEnum):
    ACTIVE = "active"
    COMPLETED = "completed"
    SUMMARIZED = "summarized"


class TranscriptSpeaker(StrEnum):
    INTERVIEWER = "interviewer"
    CANDIDATE = "candidate"
    UNKNOWN = "unknown"


# ── Transcript ────────────────────────────────────────────────────────────────

class TranscriptSegmentCreate(BaseModel):
    speaker: TranscriptSpeaker = TranscriptSpeaker.UNKNOWN
    content: str = Field(..., min_length=1, max_length=8000)
    offset_ms: int | None = None
    duration_ms: int | None = None
    source: str = "manual"


class TranscriptSegmentResponse(BaseModel):
    id: UUID
    session_id: UUID
    interview_id: UUID
    speaker: str
    content: str
    offset_ms: int | None
    duration_ms: int | None
    source: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ── Session ───────────────────────────────────────────────────────────────────

class CopilotSessionResponse(BaseModel):
    id: UUID
    organization_id: UUID
    interview_id: UUID
    status: str
    summary: dict | None
    skills_covered: dict | None
    prompt_tokens_used: int
    completion_tokens_used: int
    created_at: datetime
    updated_at: datetime
    summarized_at: datetime | None

    model_config = ConfigDict(from_attributes=True)


# ── Summary request ───────────────────────────────────────────────────────────

class SummarizeRequest(BaseModel):
    """Trigger post-interview summary generation."""
    force: bool = False  # Re-generate even if summary already exists


# ── WebSocket event envelopes ─────────────────────────────────────────────────

class WsEventType(StrEnum):
    TRANSCRIPT_ADDED = "transcript_added"
    SUMMARY_READY = "summary_ready"
    SESSION_UPDATED = "session_updated"
    ERROR = "error"
    PING = "ping"
    PONG = "pong"
