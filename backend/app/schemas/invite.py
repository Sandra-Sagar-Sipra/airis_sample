from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, EmailStr, Field


class InviteCreate(BaseModel):
    email: EmailStr
    # organization_roles.key (system or custom) for the target org
    role: str = Field(default="recruiter", min_length=1, max_length=64)
    expires_in_days: int = Field(default=7, ge=1, le=30)


class InviteResponse(BaseModel):
    id: str
    email: str
    organization_id: str
    role: str
    status: str
    expires_at: datetime
    created_at: datetime
    # F-INV-05: lifecycle timestamps
    sent_at: Optional[datetime] = None
    opened_at: Optional[datetime] = None
    accepted_at: Optional[datetime] = None
    expired_at: Optional[datetime] = None
    # F-INV-04: delivery tracking
    delivery_status: str = "pending"
    delivery_provider: Optional[str] = None
    message_id: Optional[str] = None
    delivery_attempts: int = 0
    last_delivery_attempt_at: Optional[datetime] = None
    last_delivery_error: Optional[str] = None


class InviteCreateResponse(BaseModel):
    message: str
    invite: InviteResponse
    token: str


class InviteListItem(BaseModel):
    id: str
    email: str
    role: str
    status: str
    created_at: datetime
    expires_at: datetime
    # F-INV-05: lifecycle timestamps (optional — only present after transition)
    sent_at: Optional[datetime] = None
    opened_at: Optional[datetime] = None
    accepted_at: Optional[datetime] = None
    expired_at: Optional[datetime] = None
    # F-INV-04: delivery tracking (summary only in list view)
    delivery_status: str = "pending"
    delivery_attempts: int = 0
    last_delivery_attempt_at: Optional[datetime] = None


class InviteResendResponse(BaseModel):
    message: str


class InviteAcceptRequest(BaseModel):
    token: str = Field(min_length=8, max_length=255)
    password: str = Field(min_length=8, max_length=128)


class InviteAcceptResponse(BaseModel):
    message: str


# ── SMTP diagnostic ───────────────────────────────────────────────────────────

class SmtpCheckResponse(BaseModel):
    connected: bool
    authenticated: bool
    test_sent: bool
    smtp_host: str
    smtp_port: int
    smtp_from: Optional[str]
    error: Optional[str] = None
