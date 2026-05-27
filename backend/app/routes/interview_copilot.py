from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile, status
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user, require_permission
from app.core.permissions import INTERVIEWS_COPILOT, INTERVIEWS_READ
from app.db.session import get_db
from app.schemas.auth import CurrentUser
from app.schemas.interview_copilot import (
    CopilotSessionResponse,
    SummarizeRequest,
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


# ── AssemblyAI realtime credential ───────────────────────────────────────────

@router.get(
    "/assemblyai-token",
    status_code=status.HTTP_200_OK,
    summary="Return the AssemblyAI credential the browser needs to open a realtime WebSocket",
)
def get_assemblyai_token(
    interview_id: UUID,  # noqa: ARG001 — kept for route-prefix consistency
    _: Annotated[CurrentUser, Depends(require_permission(INTERVIEWS_COPILOT))],
) -> dict:
    """Return the AssemblyAI API key as ``{"token": key}`` so the browser can
    open a realtime transcription WebSocket.

    AssemblyAI's realtime WebSocket (``wss://streaming.assemblyai.com/v3/ws``)
    accepts the API key directly in the ``?token=`` query parameter.

    Sending the key over HTTPS to authenticated users keeps it out of the
    build artefacts and environment variables on the client side.  The key is
    never written to logs by this handler.
    """
    from app.core.config import get_settings  # noqa: PLC0415

    api_key = (get_settings().assemblyai_api_key or "").strip()
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AssemblyAI is not configured on this deployment. Set ASSEMBLYAI_API_KEY in the backend environment.",
        )

    return {"token": api_key}


# ── Audio transcription (Whisper — kept for post-processing / non-realtime use)


@router.post(
    "/transcribe-audio",
    response_model=TranscriptSegmentResponse | None,
    status_code=status.HTTP_200_OK,
    summary="Transcribe an audio chunk via OpenAI Whisper and save as a transcript segment",
)
async def transcribe_audio_segment(
    interview_id: UUID,
    audio: UploadFile = File(..., description="Audio blob from MediaRecorder (webm/ogg/mp4)"),
    speaker: str = Form(default="interviewer", description="Speaker: interviewer | candidate | unknown"),
    language: str = Form(default="en", description="BCP-47 language code for Whisper hint"),
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_permission(INTERVIEWS_COPILOT)),
    current_user: CurrentUser = Depends(get_current_user),
) -> TranscriptSegmentResponse | None:
    """Receive a raw audio blob from the frontend MediaRecorder, transcribe it
    with OpenAI Whisper, and persist the resulting text as a transcript segment.

    Returns 200 with the saved segment, or 200 with null body when the audio
    was silent / too short to produce a transcription.  Returns 503 when
    OpenAI is not configured.
    """
    from app.services.transcription import (  # noqa: PLC0415
        TranscriptionUnavailableError,
        create_transcription_provider,
    )
    from app.schemas.interview_copilot import TranscriptSpeaker  # noqa: PLC0415

    audio_data = await audio.read()

    # Reject tiny blobs — anything under 4 KB is almost certainly silence or
    # just the WebM container header with no audio payload.
    if len(audio_data) < 4_000:
        return None

    provider = create_transcription_provider()
    if not provider.is_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                f"Transcription provider '{provider.provider_name}' is not configured. "
                "Set the required API key in the backend environment."
            ),
        )

    try:
        text = provider.transcribe(
            audio_data=audio_data,
            filename=audio.filename or "chunk.webm",
            language=language,
        )
    except TranscriptionUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        )

    if not text.strip():
        return None

    valid_speakers = {s.value for s in TranscriptSpeaker}
    speaker_enum = (
        TranscriptSpeaker(speaker) if speaker in valid_speakers else TranscriptSpeaker.UNKNOWN
    )

    svc = CopilotService(db)
    seg = svc.add_transcript_segment(
        interview_id=interview_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
        payload=TranscriptSegmentCreate(
            speaker=speaker_enum,
            content=text,
            source="whisper",
        ),
    )
    return TranscriptSegmentResponse.model_validate(seg)


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
