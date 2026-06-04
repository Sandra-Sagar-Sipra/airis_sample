"""Pydantic schemas for job duplicate detection."""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class DuplicateJobCheckRequest(BaseModel):
    title: str = Field(description="Job title to check for duplicates.")
    client_id: UUID | None = Field(default=None, description="Client ID to include in duplicate detection.")
    location: str | None = Field(default=None, description="Location to check for duplicates.")
    exclude_id: UUID | None = Field(default=None, description="Exclude a specific job ID from the check.")


class DuplicateJobMatchOut(BaseModel):
    """A job that may be a duplicate."""
    job_id: str
    title: str
    status: str
    created_at: datetime
    client_id: str | None
    location: str | None
    confidence: float


class DuplicateJobCheckResult(BaseModel):
    """Response body for POST /jobs/check-duplicate."""
    has_duplicates: bool
    matches: list[DuplicateJobMatchOut]
