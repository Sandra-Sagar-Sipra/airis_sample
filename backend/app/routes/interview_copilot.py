from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, Query, status
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user, require_permission
from app.core.permissions import INTERVIEWS_COPILOT, INTERVIEWS_READ
from app.db.session import get_db
from app.schemas.auth import CurrentUser
from app.schemas.interview_copilot import (
    AISuggestionResponse,
    CopilotSessionResponse,
    SuggestRequest,
    SummarizeRequest,
    SuggestionUseRequest,
    TranscriptSegmentCreate,
    TranscriptSegmentResponse,
)
from app.core.paths import append_debug_log
from app.services.copilot_service import CopilotService


def _debug_log(hypothesis_id: str, location: str, message: str, data: dict) -> None:
    append_debug_log(
        "debug-f65d2f.log",
        {
            "sessionId": "f65d2f",
            "runId": "post-fix",
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data,
        },
    )

router = APIRouter(
    prefix="/interviews/{interview_id}/copilot",
    tags=["interview-copilot"],
)


# ── Session ───────────────────────────────────────────────────────────────────

@router.post(
    "/session",
    response_model=CopilotSessionResponse,
    status_code=status.HTTP_200_OK,
    summary="Start or retrieve the copilot session for this interview",
)
def get_or_create_session(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_COPILOT))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> CopilotSessionResponse:
    _debug_log(
        "H5",
        "backend/app/routes/interview_copilot.py:get_or_create_session",
        "Handler reached — all dependencies resolved",
        {
            "interview_id": str(interview_id),
            "user_id": current_user.user_id,
            "org_id": current_user.organization_id,
        },
    )
    try:
        svc = CopilotService(db)
        sess = svc.get_or_create_session(
            interview_id=interview_id,
            organization_id=UUID(current_user.organization_id),
            current_user=current_user,
        )
        result = CopilotSessionResponse.model_validate(sess)
        _debug_log(
            "H6",
            "backend/app/routes/interview_copilot.py:get_or_create_session",
            "Session resolved and serialized successfully",
            {"session_id": str(result.id), "status": result.status},
        )
        return result
    except Exception as exc:
        _debug_log(
            "H6",
            "backend/app/routes/interview_copilot.py:get_or_create_session",
            "Exception in handler body",
            {"exc_type": type(exc).__name__, "exc_str": str(exc)[:500]},
        )
        raise


@router.get(
    "/session",
    response_model=CopilotSessionResponse,
    summary="Get the existing copilot session",
)
def get_session(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> CopilotSessionResponse:
    svc = CopilotService(db)
    sess = svc.get_session(
        interview_id=interview_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
    )
    return CopilotSessionResponse.model_validate(sess)


# ── Transcript ────────────────────────────────────────────────────────────────

@router.post(
    "/transcript",
    response_model=TranscriptSegmentResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Append a transcript segment",
)
def add_transcript_segment(
    interview_id: UUID,
    payload: TranscriptSegmentCreate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_COPILOT))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> TranscriptSegmentResponse:
    svc = CopilotService(db)
    seg = svc.add_transcript_segment(
        interview_id=interview_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
        payload=payload,
    )
    return TranscriptSegmentResponse.model_validate(seg)


@router.get(
    "/transcript",
    response_model=list[TranscriptSegmentResponse],
    summary="List all transcript segments in chronological order",
)
def list_transcript_segments(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[TranscriptSegmentResponse]:
    svc = CopilotService(db)
    segments = svc.list_transcript_segments(
        interview_id=interview_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
        limit=limit,
        offset=offset,
    )
    return [TranscriptSegmentResponse.model_validate(s) for s in segments]


# ── Suggestions ───────────────────────────────────────────────────────────────

@router.post(
    "/suggest",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Trigger AI suggestion generation (async — check /suggestions for results)",
)
def trigger_suggestions(
    interview_id: UUID,
    payload: SuggestRequest,
    db: Annotated[Session, Depends(get_db)],
    background_tasks: BackgroundTasks,
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_COPILOT))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> dict:
    svc = CopilotService(db)
    return svc.trigger_suggestions(
        interview_id=interview_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
        payload=payload,
        background_tasks=background_tasks,
    )


@router.get(
    "/suggestions",
    response_model=list[AISuggestionResponse],
    summary="List AI suggestions for this interview",
)
def list_suggestions(
    interview_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    include_dismissed: Annotated[bool, Query()] = False,
) -> list[AISuggestionResponse]:
    svc = CopilotService(db)
    suggestions = svc.list_suggestions(
        interview_id=interview_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
        include_dismissed=include_dismissed,
    )
    return [AISuggestionResponse.model_validate(s) for s in suggestions]


@router.patch(
    "/suggestions/{suggestion_id}",
    response_model=AISuggestionResponse,
    summary="Mark a suggestion as used or dismissed",
)
def mark_suggestion(
    interview_id: UUID,
    suggestion_id: UUID,
    payload: SuggestionUseRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_COPILOT))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> AISuggestionResponse:
    svc = CopilotService(db)
    sug = svc.mark_suggestion(
        interview_id=interview_id,
        suggestion_id=suggestion_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
        used=payload.used,
        dismissed=payload.dismissed,
    )
    return AISuggestionResponse.model_validate(sug)


# ── Summary ───────────────────────────────────────────────────────────────────

@router.post(
    "/summarize",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Trigger post-interview AI summary generation (async)",
)
def trigger_summary(
    interview_id: UUID,
    payload: SummarizeRequest,
    db: Annotated[Session, Depends(get_db)],
    background_tasks: BackgroundTasks,
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_COPILOT))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> dict:
    svc = CopilotService(db)
    return svc.trigger_summary(
        interview_id=interview_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
        force=payload.force,
        background_tasks=background_tasks,
    )
