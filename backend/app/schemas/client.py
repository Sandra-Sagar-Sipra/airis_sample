from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class ClientBase(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    legal_name: str | None = Field(default=None, max_length=255)
    industry: str | None = Field(default=None, max_length=120)
    website: str | None = Field(default=None, max_length=500)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=50)
    location: str | None = Field(default=None, max_length=255)
    notes: str | None = None


class ClientCreate(ClientBase):
    # WS-002: industry and contact_email are required on creation.
    industry: str = Field(min_length=1, max_length=120)
    email: EmailStr
    # Optional list of recruiter profile IDs to assign on creation.
    assigned_recruiter_ids: list[UUID] = Field(default_factory=list)


class ClientUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    legal_name: str | None = Field(default=None, max_length=255)
    industry: str | None = Field(default=None, max_length=120)
    website: str | None = Field(default=None, max_length=500)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=50)
    location: str | None = Field(default=None, max_length=255)
    notes: str | None = None


class ClientRecruiterResponse(BaseModel):
    """Assignment record enriched with the recruiter's email and role."""

    recruiter_id: UUID
    assigned_at: datetime
    assigned_by: UUID | None
    # Profile fields joined at query time — may be None if profile was deleted.
    email: str | None = None
    role: str | None = None

    model_config = ConfigDict(from_attributes=True)


class RecruiterUserResponse(BaseModel):
    """Minimal user record returned by the available-recruiters dropdown endpoint."""

    id: str
    email: str
    role: str

    model_config = ConfigDict(from_attributes=True)


class ClientResponse(ClientBase):
    id: UUID
    organization_id: UUID
    is_deleted: bool
    deleted_at: datetime | None
    assigned_recruiter_ids: list[UUID] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
