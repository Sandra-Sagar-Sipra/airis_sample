from __future__ import annotations

import logging
import traceback
from typing import Annotated
from uuid import UUID

_lk_log = logging.getLogger("airis.livekit")

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.dependencies import get_current_user, require_permission
from app.core.permissions import (
    INTERVIEWS_CLAIM,
    INTERVIEWS_CREATE,
    INTERVIEWS_DELETE,
    INTERVIEWS_FEEDBACK,
    INTERVIEWS_PANEL,
    INTERVIEWS_READ,
    INTERVIEWS_UPDATE,
)
from app.db.session import get_db
from app.schemas.auth import CurrentUser
from app.schemas.interview import (
    AISummaryResponse,
    AISummaryUpdate,
    InterviewCreate,
    InterviewReminderResponse,
    InterviewFeedbackCreate,
    InterviewFeedbackResponse,
    InterviewParticipantCreate,
    InterviewParticipantResponse,
    InterviewResponse,
    InterviewUpdate,
    InterviewerProfileCreate,
    InterviewerProfileResponse,
    NoteResponse,
    NoteUpsert,
    QueueInterviewResponse,
    WorkspaceResponse,
)
from app.services.interview_service import InterviewService
from app.services.livekit_service import generate_token, get_room_name

router = APIRouter(prefix="/interviews", tags=["interviews"])


# ── Create / List ────────────────────────────────────────────────────────

@router.post("", response_model=InterviewResponse, status_code=status.HTTP_201_CREATED)
def create_interview(
    payload: InterviewCreate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_CREATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> InterviewResponse:
    svc = InterviewService(db)
    interview = svc.create_interview(UUID(current_user.organization_id), current_user, payload)
    return InterviewResponse.model_validate(interview)


@router.get("", response_model=list[InterviewResponse])
def list_interviews(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    pipeline_id: Annotated[UUID | None, Query()] = None,
    candidate_id: Annotated[UUID | None, Query()] = None,
    job_id: Annotated[UUID | None, Query()] = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
) -> list[InterviewResponse]:
    svc = InterviewService(db)
    interviews = svc.list_interviews(
        UUID(current_user.organization_id),
        current_user,
        limit=limit,
        offset=offset,
        pipeline_id=pipeline_id,
        candidate_id=candidate_id,
        job_id=job_id,
        status_filter=status_filter,
    )
    return [InterviewResponse.model_validate(i) for i in interviews]


# ── Queue (interviews needing panelists) ─────────────────────────────────

@router.get("/queue", response_model=list[QueueInterviewResponse])
def get_interview_queue(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    round_type: Annotated[str | None, Query()] = None,
    job_id: Annotated[UUID | None, Query()] = None,
) -> list[QueueInterviewResponse]:
    svc = InterviewService(db)
    return svc.get_queue(
        UUID(current_user.organization_id),
        current_user,
        limit=limit,
        offset=offset,
        round_type=round_type,
        job_id=job_id,
    )


# ── My Interviews ────────────────────────────────────────────────────────

@router.get("/my", response_model=list[InterviewResponse])
def get_my_interviews(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[InterviewResponse]:
    svc = InterviewService(db)
    interviews = svc.get_my_interviews(
        UUID(current_user.organization_id),
        current_user,
        limit=limit,
        offset=offset,
    )
    return [InterviewResponse.model_validate(i) for i in interviews]


# ── Interviewer Profile (static paths before /{interview_id}) ────────────

@router.get("/profile/me", response_model=InterviewerProfileResponse | None)
def get_my_profile(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> InterviewerProfileResponse | None:
    svc = InterviewService(db)
    profile = svc.get_my_profile(UUID(current_user.organization_id), current_user)
    if profile is None:
        return None
    resp = InterviewerProfileResponse.model_validate(profile)
    resp.skills = svc.get_profile_skills(profile.id)
    return resp


@router.put("/profile/me", response_model=InterviewerProfileResponse)
def upsert_my_profile(
    payload: InterviewerProfileCreate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> InterviewerProfileResponse:
    svc = InterviewService(db)
    profile = svc.upsert_my_profile(UUID(current_user.organization_id), current_user, payload)
    resp = InterviewerProfileResponse.model_validate(profile)
    resp.skills = svc.get_profile_skills(profile.id)
    return resp


# ── Single interview ─────────────────────────────────────────────────────

@router.get("/{interview_id}", response_model=InterviewResponse)
def get_interview(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> InterviewResponse:
    svc = InterviewService(db)
    interview = svc.get_interview_by_id(interview_id, UUID(current_user.organization_id), current_user)
    return InterviewResponse.model_validate(interview)


@router.patch("/{interview_id}", response_model=InterviewResponse)
def update_interview(
    interview_id: UUID,
    payload: InterviewUpdate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> InterviewResponse:
    svc = InterviewService(db)
    interview = svc.update_interview(
        interview_id=interview_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
        payload=payload,
    )
    return InterviewResponse.model_validate(interview)


@router.put("/{interview_id}", response_model=InterviewResponse)
def update_interview_put(
    interview_id: UUID,
    payload: InterviewUpdate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> InterviewResponse:
    svc = InterviewService(db)
    interview = svc.update_interview(
        interview_id=interview_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
        payload=payload,
    )
    return InterviewResponse.model_validate(interview)


@router.delete("/{interview_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_interview(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_DELETE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> None:
    svc = InterviewService(db)
    svc.delete_interview(interview_id, UUID(current_user.organization_id), current_user)


# ── Claim (self-assign as panelist) ─────────────────────────────────────

@router.post("/{interview_id}/claim", response_model=InterviewParticipantResponse, status_code=status.HTTP_201_CREATED)
def claim_interview(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_CLAIM))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> InterviewParticipantResponse:
    svc = InterviewService(db)
    participant = svc.claim_interview(interview_id, UUID(current_user.organization_id), current_user)
    return InterviewParticipantResponse.model_validate(participant)


# ── Participants ─────────────────────────────────────────────────────────

@router.get("/{interview_id}/participants", response_model=list[InterviewParticipantResponse])
def list_participants(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> list[InterviewParticipantResponse]:
    svc = InterviewService(db)
    participants = svc.list_participants(interview_id, UUID(current_user.organization_id), current_user)
    return [InterviewParticipantResponse.model_validate(p) for p in participants]


@router.post("/{interview_id}/participants", response_model=InterviewParticipantResponse, status_code=status.HTTP_201_CREATED)
def add_participant(
    interview_id: UUID,
    payload: InterviewParticipantCreate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_PANEL))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> InterviewParticipantResponse:
    svc = InterviewService(db)
    participant = svc.add_participant(interview_id, UUID(current_user.organization_id), current_user, payload)
    return InterviewParticipantResponse.model_validate(participant)


@router.delete("/{interview_id}/participants/{participant_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_participant(
    interview_id: UUID,
    participant_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_PANEL))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> None:
    svc = InterviewService(db)
    svc.remove_participant(interview_id, participant_id, UUID(current_user.organization_id), current_user)


# ── Feedback ─────────────────────────────────────────────────────────────

@router.post(
    "/{interview_id}/feedback",
    response_model=InterviewFeedbackResponse,
    status_code=status.HTTP_201_CREATED,
)
def submit_feedback(
    interview_id: UUID,
    payload: InterviewFeedbackCreate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_FEEDBACK))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> InterviewFeedbackResponse:
    svc = InterviewService(db)
    feedback = svc.create_feedback(
        interview_id=interview_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
        payload=payload,
    )
    return InterviewFeedbackResponse.model_validate(feedback)


@router.get("/{interview_id}/feedback", response_model=list[InterviewFeedbackResponse])
def get_feedback(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> list[InterviewFeedbackResponse]:
    svc = InterviewService(db)
    feedback_list = svc.get_feedback(
        interview_id=interview_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
    )
    return [InterviewFeedbackResponse.model_validate(f) for f in feedback_list]


# ── Workspace ─────────────────────────────────────────────────────────────

@router.get("/{interview_id}/workspace", response_model=WorkspaceResponse)
def get_workspace(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> WorkspaceResponse:
    svc = InterviewService(db)
    return svc.get_workspace(interview_id, UUID(current_user.organization_id), current_user)


# ── Notes ─────────────────────────────────────────────────────────────────

@router.get("/{interview_id}/notes", response_model=list[NoteResponse])
def get_notes(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> list[NoteResponse]:
    svc = InterviewService(db)
    notes = svc.get_notes(interview_id, UUID(current_user.organization_id), current_user)
    return [NoteResponse.model_validate(n) for n in notes]


@router.patch("/{interview_id}/notes", response_model=NoteResponse)
def upsert_note(
    interview_id: UUID,
    payload: NoteUpsert,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> NoteResponse:
    svc = InterviewService(db)
    note = svc.upsert_note(interview_id, UUID(current_user.organization_id), current_user, payload)
    return NoteResponse.model_validate(note)


# ── Status controls ───────────────────────────────────────────────────────

@router.post("/{interview_id}/start", response_model=InterviewResponse)
def start_interview(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> InterviewResponse:
    svc = InterviewService(db)
    interview = svc.start_interview(interview_id, UUID(current_user.organization_id), current_user)
    return InterviewResponse.model_validate(interview)


@router.post("/{interview_id}/complete", response_model=InterviewResponse)
def complete_interview(
    interview_id: UUID,
    background_tasks: BackgroundTasks,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> InterviewResponse:
    svc = InterviewService(db)
    interview = svc.complete_interview(
        interview_id,
        UUID(current_user.organization_id),
        current_user,
        background_tasks=background_tasks,
    )
    return InterviewResponse.model_validate(interview)


@router.post("/{interview_id}/no-show", response_model=InterviewResponse)
def mark_no_show(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> InterviewResponse:
    svc = InterviewService(db)
    interview = svc.mark_no_show(interview_id, UUID(current_user.organization_id), current_user)
    return InterviewResponse.model_validate(interview)


# ── Reminders (SCHED-006) ────────────────────────────────────────────────

@router.get("/{interview_id}/reminders", response_model=list[InterviewReminderResponse])
def get_reminders(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> list[InterviewReminderResponse]:
    """Return all reminder rows for an interview (for admin/recruiter visibility)."""
    svc = InterviewService(db)
    reminders = svc.get_reminders(interview_id, UUID(current_user.organization_id), current_user)
    return [InterviewReminderResponse.model_validate(r) for r in reminders]


# ── AI Summary (AI-004) ───────────────────────────────────────────────────

@router.get("/{interview_id}/summary", response_model=AISummaryResponse)
def get_ai_summary(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> AISummaryResponse:
    """Return the current AI-generated summary for a completed interview."""
    svc = InterviewService(db)
    return svc.get_ai_summary(interview_id, UUID(current_user.organization_id), current_user)


@router.post("/{interview_id}/summary/generate", response_model=dict, status_code=status.HTTP_202_ACCEPTED)
def generate_ai_summary(
    interview_id: UUID,
    background_tasks: BackgroundTasks,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> dict:
    """Manually (re-)trigger AI summary generation for a completed interview.
    Returns 202 immediately; poll GET /summary for the result."""
    svc = InterviewService(db)
    return svc.regenerate_ai_summary(
        interview_id,
        UUID(current_user.organization_id),
        current_user,
        background_tasks,
    )


@router.patch("/{interview_id}/summary", response_model=AISummaryResponse)
def update_ai_summary(
    interview_id: UUID,
    payload: AISummaryUpdate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> AISummaryResponse:
    """Recruiter edits to the AI-generated summary. Sets ai_summary_edited=true."""
    svc = InterviewService(db)
    return svc.update_ai_summary(
        interview_id,
        UUID(current_user.organization_id),
        current_user,
        payload,
    )


# ── LiveKit embedded meeting ──────────────────────────────────────────────

class LiveKitTokenResponse(BaseModel):
    token: str
    ws_url: str
    room_name: str
    identity: str


@router.post(
    "/{interview_id}/livekit/token",
    response_model=LiveKitTokenResponse,
    summary="Generate a short-lived LiveKit access token for the embedded meeting room",
)
def get_livekit_token(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> LiveKitTokenResponse:
    """
    Returns a signed LiveKit access token that grants the caller permission to
    join the interview's dedicated LiveKit room.

    Room name is deterministic: ``airis-interview-{interview_id}``.

    Requires ``LIVEKIT_API_KEY``, ``LIVEKIT_API_SECRET``, and ``LIVEKIT_WS_URL``
    in backend/.env.  Returns 503 if LiveKit is not configured.
    """
    settings = get_settings()
    api_key = settings.livekit_api_key
    api_secret = settings.livekit_api_secret
    ws_url = settings.livekit_ws_url

    missing = [
        name
        for name, val in [
            ("LIVEKIT_API_KEY", api_key),
            ("LIVEKIT_API_SECRET", api_secret),
            ("LIVEKIT_WS_URL (or LIVEKIT_URL)", ws_url),
        ]
        if not val
    ]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                f"LiveKit is not configured. Missing: {', '.join(missing)}. "
                "Set these in backend/.env and restart the backend."
            ),
        )
    if api_key is None or api_secret is None or ws_url is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LiveKit is not configured.",
        )

    # Verify the caller has access to this interview (org-scoped read is sufficient).
    try:
        svc = InterviewService(db)
        svc.get_interview_by_id(interview_id, UUID(current_user.organization_id), current_user)
    except HTTPException:
        raise
    except Exception:
        _lk_log.error("[LiveKit] interview lookup failed:\n%s", traceback.format_exc())
        raise

    try:
        room_name = get_room_name(interview_id)
        identity = str(current_user.user_id)
        display_name = (
            getattr(current_user, "full_name", None)
            or getattr(current_user, "name", None)
            or getattr(current_user, "email", None)
            or identity
        )
        token = generate_token(
            api_key=api_key,
            api_secret=api_secret,
            room_name=room_name,
            participant_identity=identity,
            participant_name=display_name,
        )
    except Exception:
        _lk_log.error("[LiveKit] token generation failed:\n%s", traceback.format_exc())
        raise

    return LiveKitTokenResponse(
        token=token,
        ws_url=ws_url,
        room_name=room_name,
        identity=identity,
    )


# ── Guest token (candidate join — no auth required) ──────────────────────────

class GuestJoinRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, description="Candidate's display name in the meeting")


@router.post(
    "/{interview_id}/livekit/guest-token",
    response_model=LiveKitTokenResponse,
    summary="Generate a guest LiveKit token for a candidate (no authentication required)",
)
def get_livekit_guest_token(
    interview_id: UUID,
    payload: GuestJoinRequest,
    db: Annotated[Session, Depends(get_db)],
) -> LiveKitTokenResponse:
    """
    Issues a short-lived LiveKit token for a candidate to join the interview room.

    **No authentication required** — the interview UUID (128-bit random) is the
    room secret; it is unguessable in practice.

    Rejects requests for interviews that are ``cancelled`` or ``no_show`` (410 Gone).
    Returns 503 if LiveKit is not configured on this server.
    """
    from app.models.interview import Interview  # local import to avoid circular dep

    settings = get_settings()
    api_key = settings.livekit_api_key
    api_secret = settings.livekit_api_secret
    ws_url = settings.livekit_ws_url

    missing = [
        name
        for name, val in [
            ("LIVEKIT_API_KEY", api_key),
            ("LIVEKIT_API_SECRET", api_secret),
            ("LIVEKIT_WS_URL (or LIVEKIT_URL)", ws_url),
        ]
        if not val
    ]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                f"LiveKit is not configured. Missing: {', '.join(missing)}. "
                "Set these in backend/.env and restart the backend."
            ),
        )
    if api_key is None or api_secret is None or ws_url is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LiveKit is not configured.",
        )

    interview = db.get(Interview, interview_id)
    if not interview:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    if interview.status in ("cancelled", "no_show"):
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="This interview is no longer active.",
        )

    room_name = get_room_name(interview_id)
    # Use a guest-prefixed identity so hosts can distinguish candidates in the room
    identity = f"guest-{interview_id}"
    display_name = payload.name.strip() or "Candidate"

    try:
        token = generate_token(
            api_key=api_key,
            api_secret=api_secret,
            room_name=room_name,
            participant_identity=identity,
            participant_name=display_name,
        )
    except Exception:
        _lk_log.error("[LiveKit] guest token generation failed:\n%s", traceback.format_exc())
        raise

    return LiveKitTokenResponse(
        token=token,
        ws_url=ws_url,
        room_name=room_name,
        identity=identity,
    )
