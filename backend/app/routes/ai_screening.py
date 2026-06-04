"""AI Screening routes.

Pattern overview
─────────────────
POST   /ai-screenings              → create + immediately kick off question generation in background
GET    /ai-screenings              → list screenings for org
GET    /ai-screenings/{id}         → full detail with Q+A+evaluations
POST   /ai-screenings/{id}/regenerate-questions → re-run question generation
PUT    /ai-screenings/{id}/answers/{question_id} → upsert one answer
POST   /ai-screenings/{id}/evaluate → trigger AI evaluation in background
POST   /ai-screenings/{id}/decision → record recruiter decision
DELETE /ai-screenings/{id}         → delete screening
"""
from __future__ import annotations

import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, File as _File, Form as _Form, Query, Request, UploadFile as _UploadFile, status

logger = logging.getLogger(__name__)
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user, require_permission
from app.core.permissions import (
    AI_SCREENING_CREATE,
    AI_SCREENING_DELETE,
    AI_SCREENING_EVALUATE,
    AI_SCREENING_READ,
    AI_SCREENING_RESULTS_READ,
    AI_SCREENING_UPDATE,
)
from app.db.session import get_db
from app.schemas.ai_screening import (
    AIScreeningCreate,
    AIScreeningDetailResponse,
    AIScreeningListItem,
    AIScreeningRecruiterDecision,
    AIScreeningResponse,
    AnswerUpsert,
    AIScreeningAnswerResponse,
    StartScreeningPayload,
    MoveStagePayload,
)
from app.schemas.auth import CurrentUser
from app.services.ai_screening_service import AIScreeningService

router = APIRouter(prefix="/ai-screenings", tags=["ai-screenings"])


def _svc(db: Session) -> AIScreeningService:
    return AIScreeningService(db)


# ── Create ────────────────────────────────────────────────────────────────────

@router.post("", response_model=AIScreeningResponse, status_code=status.HTTP_201_CREATED)
def create_screening(
    payload: AIScreeningCreate,
    background_tasks: BackgroundTasks,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_CREATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> AIScreeningResponse:
    """Create a screening and immediately start AI question generation in the background.

    The response is returned instantly with status=pending.
    Poll GET /ai-screenings/{id} until status=questions_ready.
    """
    svc = _svc(db)
    org_id = UUID(current_user.organization_id)
    screening = svc.create_screening(org_id, current_user, payload)

    # Kick off question generation asynchronously — never blocks HTTP response.
    background_tasks.add_task(
        _run_generate_questions,
        org_id=org_id,
        screening_id=screening.id,
        db_url="",
    )

    return AIScreeningResponse.model_validate(screening)


# ── List ──────────────────────────────────────────────────────────────────────

@router.get("", response_model=list[AIScreeningListItem])
def list_screenings(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    candidate_id: UUID | None = Query(default=None),
    job_id: UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[AIScreeningListItem]:
    return _svc(db).list_screenings(
        UUID(current_user.organization_id),
        candidate_id=candidate_id,
        job_id=job_id,
        status=status_filter,
        limit=limit,
        offset=offset,
    )


# ── Inline Pydantic models for live interview (defined here so they are
#    available before /{screening_id} catches single-segment paths) ─────────────

from pydantic import BaseModel as _BaseModel
from typing import Optional as _Optional


class LiveInterviewCreatePayload(_BaseModel):
    candidate_id: UUID
    job_id: _Optional[UUID] = None
    max_questions: int = 12


class ReviewDecisionPayload(_BaseModel):
    decision: str   # "advance" | "reject" | "hold"
    notes: _Optional[str] = None


class SendAIScreeningInvitePayload(_BaseModel):
    candidate_id: UUID
    job_id: _Optional[UUID] = None
    pipeline_id: _Optional[UUID] = None
    expires_at: _Optional[str] = None  # ISO datetime string
    max_questions: int = 12
    interview_duration_minutes: int = 20
    custom_instructions: _Optional[str] = None


class SendAIScreeningInviteResponse(_BaseModel):
    screening_id: UUID
    candidate_email: str
    session_token: str
    interview_url: str
    invitation_sent: bool
    invitation_sent_at: _Optional[str] = None
    expires_at: _Optional[str] = None


class LiveInterviewMessageSchema(_BaseModel):
    id: str
    role: str
    content: str
    sequence_number: int
    question_number: _Optional[int] = None
    is_followup: bool
    created_at: str


class LiveInterviewResponse(_BaseModel):
    id: UUID
    candidate_id: UUID
    job_id: _Optional[UUID] = None
    status: str
    session_token: _Optional[str] = None
    livekit_room_name: _Optional[str] = None
    candidate_name_snapshot: _Optional[str] = None
    job_title_snapshot: _Optional[str] = None
    interview_mode: str = "async"
    overall_score: _Optional[float] = None
    recommendation: _Optional[str] = None
    ai_summary: _Optional[str] = None
    strengths: _Optional[list] = None
    concerns: _Optional[list] = None
    salary_expectation: _Optional[str] = None
    notice_period: _Optional[str] = None
    career_goals: _Optional[str] = None
    candidate_questions: _Optional[str] = None
    key_projects_mentioned: _Optional[list] = None
    communication_score: _Optional[float] = None
    experience_score: _Optional[float] = None
    confidence_score: _Optional[float] = None
    culture_fit_score: _Optional[float] = None
    leadership_score: _Optional[float] = None
    duration_seconds: _Optional[int] = None
    started_at: _Optional[str] = None
    ended_at: _Optional[str] = None
    created_at: str
    messages: list[LiveInterviewMessageSchema] = []
    # Completeness / incomplete reason
    incomplete_reason: _Optional[str] = None
    # Recruiter decision
    recruiter_decision: _Optional[str] = None
    recruiter_notes: _Optional[str] = None
    # Invite config
    expires_at: _Optional[str] = None
    max_questions: _Optional[int] = None
    interview_duration_minutes: _Optional[int] = None
    invitation_sent_at: _Optional[str] = None
    invitation_email: _Optional[str] = None
    video_url: _Optional[str] = None
    audio_url: _Optional[str] = None

    model_config = {"from_attributes": True}


# ── Pipeline queue (must be before /{screening_id} to avoid UUID coercion 422) ─

@router.get(
    "/pipeline-queue",
    summary="Candidates in the Screening stage with their AI interview status",
)
def get_pipeline_screening_queue(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[dict]:
    """Returns pipeline entries in the Screening stage joined with their live AI
    screening record (if one exists). Primary data source for the AI Screening list page."""
    svc = _svc(db)
    org_id = UUID(current_user.organization_id)
    return svc.get_pipeline_screening_queue(org_id, limit=limit, offset=offset)


@router.get(
    "/for-candidate/{candidate_id}",
    response_model=LiveInterviewResponse,
    summary="Get or create a live screening for a candidate in the Screening stage",
)
def get_or_create_candidate_screening(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> LiveInterviewResponse:
    """Look up the live screening for a candidate in the Screening stage.
    Auto-creates one if no record exists yet. Returns 404 if candidate
    is not currently in the Screening stage."""
    from fastapi import HTTPException

    svc = _svc(db)
    org_id = UUID(current_user.organization_id)
    screening = svc.get_or_create_for_candidate(org_id, candidate_id)
    if screening is None:
        raise HTTPException(
            status_code=404,
            detail="Candidate is not currently in the Screening stage.",
        )
    msgs = svc.get_live_messages(screening.id)
    return _to_live_response(screening, msgs)


# ── Live interview (before /{screening_id} so paths are not shadowed) ────────

@router.post(
    "/live",
    response_model=LiveInterviewResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a live AI screening interview session",
)
def create_live_interview(
    payload: LiveInterviewCreatePayload,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_CREATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> LiveInterviewResponse:
    """Create a live video interview session."""
    svc = _svc(db)
    org_id = UUID(current_user.organization_id)
    screening = svc.create_live_interview(
        org_id=org_id,
        current_user=current_user,
        candidate_id=payload.candidate_id,
        job_id=payload.job_id,
        max_questions=payload.max_questions,
    )
    return _to_live_response(screening, [])


@router.get(
    "/live/join/{token}",
    response_model=LiveInterviewResponse,
    summary="Candidate join — no auth required, token is the credential",
)
def get_live_interview_by_token(
    token: str,
    db: Annotated[Session, Depends(get_db)],
) -> LiveInterviewResponse:
    svc = _svc(db)
    screening = svc.get_screening_by_token(token)
    if screening is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Interview session not found or expired.")
    msgs = svc.get_live_messages(screening.id)
    return _to_live_response(screening, msgs)


@router.get(
    "/live/{screening_id}",
    response_model=LiveInterviewResponse,
    summary="Recruiter full live interview detail with transcript",
)
def get_live_interview(
    screening_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> LiveInterviewResponse:
    svc = _svc(db)
    org_id = UUID(current_user.organization_id)
    screening = svc.get_screening(org_id, screening_id)
    msgs = svc.get_live_messages(screening_id)
    return _to_live_response(screening, msgs)


@router.get(
    "/live/{screening_id}/assemblyai-token",
    summary="Return a temporary AssemblyAI realtime token for the candidate",
)
def get_assemblyai_token(
    screening_id: UUID,
    token: str,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Generate a short-lived AssemblyAI realtime token (browser-side STT only)."""
    import httpx
    from fastapi import HTTPException
    from app.core.config import get_settings

    svc = _svc(db)
    screening = svc.get_screening_by_token(token)
    if screening is None or str(screening.id) != str(screening_id):
        raise HTTPException(status_code=403, detail="Invalid session token.")

    settings = get_settings()
    api_key = settings.assemblyai_api_key
    if not api_key:
        logger.info("assemblyai_token.not_configured screening=%s", screening_id)
        return {"token": None, "available": False}

    token_urls = [
        (
            "https://streaming.assemblyai.com/v3/token",
            "wss://streaming.assemblyai.com/v3/ws",
        ),
        (
            "https://streaming.eu.assemblyai.com/v3/token",
            "wss://streaming.eu.assemblyai.com/v3/ws",
        ),
    ]
    for token_url, ws_url in token_urls:
        try:
            resp = httpx.get(
                token_url,
                headers={"Authorization": api_key},
                params={"expires_in_seconds": 600},
                timeout=10,
            )
            resp.raise_for_status()
            token = resp.json().get("token")
            if token:
                logger.info(
                    "assemblyai_token.generated screening=%s endpoint=%s",
                    screening_id,
                    token_url,
                )
                return {"token": token, "available": True, "ws_url": ws_url}
            logger.warning(
                "assemblyai_token.empty screening=%s endpoint=%s",
                screening_id,
                token_url,
            )
        except Exception as exc:
            logger.warning(
                "assemblyai_token.request_failed screening=%s endpoint=%s error=%s",
                screening_id,
                token_url,
                exc,
            )
    return {"token": None, "available": False}


# ── Send AI Screening Invite ──────────────────────────────────────────────────

@router.post(
    "/send-invite",
    response_model=SendAIScreeningInviteResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a live AI screening session and email the candidate the invite link",
)
def send_ai_screening_invite(
    payload: SendAIScreeningInvitePayload,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_CREATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> SendAIScreeningInviteResponse:
    """Create a self-service AI screening session and email the candidate.

    The candidate receives a link to /interview/<token> where they complete the
    AI video interview without logging in.
    """
    from datetime import datetime
    from app.core.config import get_settings
    from fastapi import HTTPException

    org_id = UUID(current_user.organization_id)

    # Parse expires_at
    expires_at = None
    if payload.expires_at:
        try:
            expires_at = datetime.fromisoformat(payload.expires_at)
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid expires_at format. Use ISO 8601.")

    svc = _svc(db)
    screening = svc.send_invite(
        org_id=org_id,
        current_user=current_user,
        candidate_id=payload.candidate_id,
        job_id=payload.job_id,
        expires_at=expires_at,
        max_questions=payload.max_questions,
        interview_duration_minutes=payload.interview_duration_minutes,
        custom_instructions=payload.custom_instructions,
        pipeline_id=payload.pipeline_id,
    )

    settings = get_settings()
    interview_url = f"{settings.frontend_url.rstrip('/')}/interview/{screening.session_token}"

    return SendAIScreeningInviteResponse(
        screening_id=screening.id,
        candidate_email=screening.invitation_email or "",
        session_token=screening.session_token or "",
        interview_url=interview_url,
        invitation_sent=screening.invitation_sent_at is not None,
        invitation_sent_at=screening.invitation_sent_at.isoformat() if screening.invitation_sent_at else None,
        expires_at=screening.expires_at.isoformat() if screening.expires_at else None,
    )


# ── Recording Upload (candidate-facing, token-authenticated) ─────────────────

@router.post(
    "/live/{screening_id}/upload-recording",
    summary="Receive full interview recording + per-question segments from browser",
)
async def upload_screening_recording(
    screening_id: UUID,
    token: str,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    # FIX: UploadFile + File() / Form() must be the real FastAPI types, not
    # string annotations.  A string like "UploadFile | None" is invisible to
    # FastAPI's dependency system — the parameter resolves as None every time.
    video: _UploadFile | None = _File(default=None),
    segments_json: str | None = _Form(default=None),
    transcript_json: str | None = _Form(default=None),
) -> dict:
    """Accept the full WebM recording, per-question segment clips, and transcript
    from the browser, store them in Supabase Storage, and persist URLs + segment
    rows to the database.

    Authentication: the candidate session token (no user login required).
    """
    import json as _json
    from fastapi import HTTPException

    from app.services.interview_storage_service import (
        upload_interview_video,
        upload_segment_video,
        upload_transcript,
        upload_analysis,
    )
    from app.models.ai_screening_segment import AIScreeningSegment

    # ── Diagnostics — log every request detail so failures are never silent ───
    logger.info(
        "[UPLOAD] received screening=%s content_type=%s "
        "has_video=%s segments_json_len=%s transcript_json_len=%s",
        screening_id,
        request.headers.get("content-type", "MISSING"),
        video is not None,
        len(segments_json) if segments_json else 0,
        len(transcript_json) if transcript_json else 0,
    )
    if video is not None:
        logger.info(
            "[UPLOAD] video field: filename=%s content_type=%s",
            getattr(video, "filename", "unknown"),
            getattr(video, "content_type", "unknown"),
        )

    svc = _svc(db)
    screening = svc.get_screening_by_token(token)
    if screening is None or str(screening.id) != str(screening_id):
        raise HTTPException(status_code=403, detail="Invalid session token.")

    video_key = ""
    segments: list[dict] = []

    # 1. Upload full recording
    if video is not None:
        video_bytes = await video.read()
        logger.info("[UPLOAD] received screening=%s size=%d", screening_id, len(video_bytes))
        if video_bytes:
            try:
                video_key = upload_interview_video(screening_id, video_bytes)
                screening.video_url = video_key
                logger.info("[UPLOAD] DB updated screening=%s video_url=%s", screening_id, video_key)
            except Exception as exc:
                logger.error("[UPLOAD] Supabase failure screening=%s: %s", screening_id, exc)
                # Non-fatal — continue to save segments and transcript
        else:
            logger.warning("[UPLOAD] blob was empty after read screening=%s", screening_id)
    else:
        logger.warning("[UPLOAD] no video file field in multipart request screening=%s", screening_id)

    # 2. Parse per-question segments JSON
    if segments_json:
        try:
            segments = _json.loads(segments_json)
        except Exception:
            segments = []

    # 3. Upload per-question segment clips + persist rows
    for seg in segments:
        q_num: int = seg.get("question_number", 0)
        segment_video_b64: str = seg.get("video_base64", "")
        video_clip_url = ""

        if segment_video_b64:
            import base64
            try:
                seg_bytes = base64.b64decode(segment_video_b64)
                video_clip_url = upload_segment_video(screening_id, q_num, seg_bytes)
            except Exception as exc:
                logger.warning(
                    "upload_recording.segment_failed screening=%s q=%d: %s",
                    screening_id, q_num, exc,
                )

        # Upsert segment row
        from sqlalchemy import select as _select
        existing = db.scalar(
            _select(AIScreeningSegment).where(
                AIScreeningSegment.screening_id == screening_id,
                AIScreeningSegment.question_number == q_num,
            )
        )
        if existing:
            existing.transcript = seg.get("transcript", existing.transcript)
            existing.question_start_seconds = seg.get("question_start_seconds", existing.question_start_seconds)
            existing.answer_start_seconds = seg.get("answer_start_seconds", existing.answer_start_seconds)
            existing.answer_end_seconds = seg.get("answer_end_seconds", existing.answer_end_seconds)
            existing.duration_seconds = seg.get("duration_seconds", existing.duration_seconds)
            if video_clip_url:
                existing.video_clip_url = video_clip_url
            db.add(existing)
        else:
            row = AIScreeningSegment(
                screening_id=screening_id,
                question_number=q_num,
                question_text=seg.get("question_text", ""),
                transcript=seg.get("transcript"),
                question_start_seconds=seg.get("question_start_seconds"),
                answer_start_seconds=seg.get("answer_start_seconds"),
                answer_end_seconds=seg.get("answer_end_seconds"),
                duration_seconds=seg.get("duration_seconds"),
                video_clip_url=video_clip_url or None,
            )
            db.add(row)

    # 4. Upload transcript JSON
    if transcript_json:
        try:
            transcript_data = _json.loads(transcript_json)
            upload_transcript(screening_id, transcript_data)
        except Exception as exc:
            logger.warning("upload_recording.transcript_failed screening=%s: %s", screening_id, exc)

    # 5. Upload analysis JSON (segments metadata without binary data)
    if segments:
        try:
            analysis = {
                "screening_id": str(screening_id),
                "questions": [
                    {k: v for k, v in seg.items() if k != "video_base64"}
                    for seg in segments
                ],
            }
            upload_analysis(screening_id, analysis)
        except Exception as exc:
            logger.warning("upload_recording.analysis_failed screening=%s: %s", screening_id, exc)

    db.add(screening)
    db.commit()

    return {"screening_id": str(screening_id), "status": "uploaded", "video_stored": bool(video_key)}


# ── Recruiter: review decision ────────────────────────────────────────────────

@router.post(
    "/live/{screening_id}/review-decision",
    response_model=LiveInterviewResponse,
    summary="Recruiter submits advance/reject/hold decision for a completed AI screening",
)
def submit_review_decision(
    screening_id: UUID,
    payload: ReviewDecisionPayload,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> LiveInterviewResponse:
    """Record the recruiter's review decision.

    decision="advance"  → candidate pipeline moved to Interview stage.
    decision="reject"   → candidate pipeline moved to Rejected.
    decision="hold"     → candidate stays in AI Interview stage; decision stored.

    Only valid for screenings with status=review_pending or status=incomplete.
    """
    from fastapi import HTTPException

    valid = {"advance", "reject", "hold"}
    if payload.decision not in valid:
        raise HTTPException(status_code=422, detail=f"decision must be one of {sorted(valid)}")

    org_id = UUID(current_user.organization_id)
    svc = _svc(db)
    screening = svc.submit_review_decision(
        org_id=org_id,
        screening_id=screening_id,
        decision=payload.decision,
        notes=payload.notes,
    )
    msgs = svc.get_live_messages(screening_id)
    return _to_live_response(screening, msgs)


@router.get(
    "/live/{screening_id}/recordings",
    summary="Recruiter: get signed playback URLs for the full interview recording",
)
def get_screening_recordings(
    screening_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_RESULTS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> dict:
    """Return short-lived (1 h) signed Supabase Storage URLs for the full
    interview video and audio.  Both point to the same WebM file — the browser
    decides whether to play it as video or audio-only.

    Returns null URLs when no recording was uploaded (e.g. candidate had no
    camera, or the upload failed).
    """
    from app.services.interview_storage_service import get_signed_url

    org_id = UUID(current_user.organization_id)
    svc = _svc(db)
    screening = svc.get_screening(org_id, screening_id)

    raw_key: str | None = getattr(screening, "video_url", None)
    signed: str | None = get_signed_url(raw_key) if raw_key else None

    return {
        "screening_id": str(screening_id),
        "full_video_url": signed,
        "full_audio_url": signed,   # same WebM file — audio element extracts the track
        "has_recording": bool(signed),
    }


@router.get(
    "/live/{screening_id}/segments",
    summary="Recruiter: get per-question answer segments with signed URLs",
)
def get_screening_segments(
    screening_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_RESULTS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> list[dict]:
    """Return all per-question segments for a completed live screening.

    Guarded by AI_SCREENING_RESULTS_READ so candidate-facing code can never
    call this endpoint — it returns evaluation data that must stay recruiter-only.
    """
    from sqlalchemy import select as _select
    from app.models.ai_screening_segment import AIScreeningSegment
    from app.services.interview_storage_service import get_signed_url

    org_id = UUID(current_user.organization_id)
    svc = _svc(db)
    screening = svc.get_screening(org_id, screening_id)  # 404 if not found / wrong org

    rows = list(
        db.scalars(
            _select(AIScreeningSegment)
            .where(AIScreeningSegment.screening_id == screening.id)
            .order_by(AIScreeningSegment.question_number)
        )
    )

    return [
        {
            "id": str(r.id),
            "question_number": r.question_number,
            "question_text": r.question_text,
            "transcript": r.transcript,
            "question_start_seconds": float(r.question_start_seconds) if r.question_start_seconds else None,
            "answer_start_seconds": float(r.answer_start_seconds) if r.answer_start_seconds else None,
            "answer_end_seconds": float(r.answer_end_seconds) if r.answer_end_seconds else None,
            "duration_seconds": float(r.duration_seconds) if r.duration_seconds else None,
            "video_clip_url": get_signed_url(r.video_clip_url) if r.video_clip_url else None,
        }
        for r in rows
    ]


# ── Detail ────────────────────────────────────────────────────────────────────

@router.get("/{screening_id}", response_model=AIScreeningDetailResponse)
def get_screening(
    screening_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> AIScreeningDetailResponse:
    return _svc(db).get_screening_detail(UUID(current_user.organization_id), screening_id)


# ── Re-generate questions ─────────────────────────────────────────────────────

@router.post("/{screening_id}/regenerate-questions", response_model=AIScreeningResponse)
def regenerate_questions(
    screening_id: UUID,
    background_tasks: BackgroundTasks,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> AIScreeningResponse:
    """Clear existing questions and regenerate. Useful after AI failure or manual retry."""
    from sqlalchemy import delete as sa_delete
    from app.models.ai_screening import AIScreeningQuestion

    svc = _svc(db)
    org_id = UUID(current_user.organization_id)
    screening = svc.get_screening(org_id, screening_id)

    # Delete existing questions (CASCADE removes answers + evaluations)
    db.execute(sa_delete(AIScreeningQuestion).where(AIScreeningQuestion.screening_id == screening_id))
    screening.status = "pending"
    db.add(screening)
    db.commit()

    background_tasks.add_task(
        _run_generate_questions,
        org_id=org_id,
        screening_id=screening_id,
        db_url="",
    )
    db.refresh(screening)
    return AIScreeningResponse.model_validate(screening)


# ── Upsert answer ─────────────────────────────────────────────────────────────

@router.put(
    "/{screening_id}/answers/{question_id}",
    response_model=AIScreeningAnswerResponse,
)
def upsert_answer(
    screening_id: UUID,
    question_id: UUID,
    payload: AnswerUpsert,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> AIScreeningAnswerResponse:
    answer = _svc(db).upsert_answer(
        UUID(current_user.organization_id), screening_id, question_id, payload
    )
    return AIScreeningAnswerResponse.model_validate(answer)


# ── Trigger evaluation ────────────────────────────────────────────────────────

@router.post("/{screening_id}/evaluate", response_model=AIScreeningResponse)
def evaluate_screening(
    screening_id: UUID,
    background_tasks: BackgroundTasks,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_EVALUATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> AIScreeningResponse:
    """Trigger AI evaluation of all submitted answers. Runs in background.

    Returns immediately with status=evaluating.
    Poll GET /ai-screenings/{id} until status=completed.
    """
    svc = _svc(db)
    org_id = UUID(current_user.organization_id)
    screening = svc.get_screening(org_id, screening_id)

    background_tasks.add_task(
        _run_evaluation,
        org_id=org_id,
        screening_id=screening_id,
        db_url="",
    )

    screening.status = "evaluating"
    db.add(screening)
    db.commit()
    db.refresh(screening)
    return AIScreeningResponse.model_validate(screening)


# ── Recruiter decision ────────────────────────────────────────────────────────

@router.post("/{screening_id}/decision", response_model=AIScreeningResponse)
def record_decision(
    screening_id: UUID,
    payload: AIScreeningRecruiterDecision,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> AIScreeningResponse:
    screening = _svc(db).record_recruiter_decision(
        UUID(current_user.organization_id),
        screening_id,
        decision=payload.decision.value,
        notes=payload.notes,
    )
    return AIScreeningResponse.model_validate(screening)


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/{screening_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_screening(
    screening_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_DELETE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> None:
    _svc(db).delete_screening(UUID(current_user.organization_id), screening_id)


# ── Start (create + optional pipeline move) ───────────────────────────────────

@router.post("/start", response_model=AIScreeningResponse, status_code=status.HTTP_201_CREATED)
def start_screening(
    payload: StartScreeningPayload,
    background_tasks: BackgroundTasks,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_CREATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> AIScreeningResponse:
    """Convenience endpoint: create screening + optionally move pipeline stage to ai_screening.

    Mirrors POST /ai-screenings but accepts a pipeline_id to move the candidate's
    pipeline entry in one atomic step, eliminating two round-trips from the frontend.
    """
    svc = _svc(db)
    org_id = UUID(current_user.organization_id)

    # 1. Move pipeline stage if requested
    if payload.move_pipeline_stage and payload.pipeline_id:
        from app.services.pipeline_service import PipelineService
        from app.schemas.pipeline import PipelineUpdate
        try:
            PipelineService(db).update_pipeline(
                payload.pipeline_id, org_id, current_user, PipelineUpdate(stage="ai_screening")
            )
        except Exception:
            # Non-fatal — screening is more important than stage move
            logger.warning("start_screening: pipeline stage move failed for %s", payload.pipeline_id)

    # 2. Create the screening
    create_payload = AIScreeningCreate(
        candidate_id=payload.candidate_id,
        job_id=payload.job_id,
        screening_type=payload.screening_type,
    )
    screening = svc.create_screening(org_id, current_user, create_payload)

    # 3. Kick off question generation in background
    background_tasks.add_task(
        _run_generate_questions,
        org_id=org_id,
        screening_id=screening.id,
        db_url="",
    )

    return AIScreeningResponse.model_validate(screening)


# ── Retry (re-trigger failed question generation or evaluation) ───────────────

@router.post("/{screening_id}/retry", response_model=AIScreeningResponse)
def retry_screening(
    screening_id: UUID,
    background_tasks: BackgroundTasks,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> AIScreeningResponse:
    """Re-trigger the last failed background task.

    - If status is 'failed' and no questions exist → re-run question generation.
    - If status is 'failed' and questions exist → re-run evaluation.
    - If status is 'questions_ready' → also re-run evaluation (convenient shortcut).
    """
    from app.models.ai_screening import AIScreeningQuestion

    svc = _svc(db)
    org_id = UUID(current_user.organization_id)
    screening = svc.get_screening(org_id, screening_id)

    question_count = db.scalar(
        select(func.count()).select_from(AIScreeningQuestion).where(
            AIScreeningQuestion.screening_id == screening_id
        )
    ) or 0

    if question_count == 0:
        # Re-run question generation
        screening.status = "pending"
        db.add(screening)
        db.commit()
        background_tasks.add_task(
            _run_generate_questions,
            org_id=org_id,
            screening_id=screening_id,
            db_url="",
        )
    else:
        # Re-run evaluation
        screening.status = "evaluating"
        db.add(screening)
        db.commit()
        background_tasks.add_task(
            _run_evaluation,
            org_id=org_id,
            screening_id=screening_id,
            db_url="",
        )

    db.refresh(screening)
    return AIScreeningResponse.model_validate(screening)


# ── Move pipeline stage based on screening result ─────────────────────────────

@router.post("/{screening_id}/move-stage", response_model=AIScreeningResponse)
def move_pipeline_stage(
    screening_id: UUID,
    payload: MoveStagePayload,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(AI_SCREENING_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> AIScreeningResponse:
    """Move the candidate's pipeline entry to the given stage.

    Typically called after a recruiter decides to advance or reject from the
    screening review panel.  Returns the screening row for easy frontend update.
    """
    from app.services.pipeline_service import PipelineService
    from app.schemas.pipeline import PipelineUpdate, PipelineStage

    org_id = UUID(current_user.organization_id)
    svc = _svc(db)
    screening = svc.get_screening(org_id, screening_id)

    # Validate the stage value
    valid_stages = {s.value for s in PipelineStage}
    if payload.stage not in valid_stages:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail=f"Invalid stage '{payload.stage}'. Valid: {sorted(valid_stages)}")

    PipelineService(db).update_pipeline(
        payload.pipeline_id, org_id, current_user, PipelineUpdate(stage=payload.stage)
    )

    return AIScreeningResponse.model_validate(screening)


# ── Background task helpers ───────────────────────────────────────────────────
# Each creates its own DB session so it can run independently of the request
# session (which will have been closed by the time the background task runs).

def _run_generate_questions(*, org_id: UUID, screening_id: UUID, db_url: str) -> None:
    from app.core.shutdown import is_shutting_down
    from app.db.session import SessionLocal

    if is_shutting_down():
        return

    db = SessionLocal()
    try:
        AIScreeningService(db).generate_questions(org_id, screening_id)
    finally:
        db.close()


def _run_evaluation(*, org_id: UUID, screening_id: UUID, db_url: str) -> None:
    from app.core.shutdown import is_shutting_down
    from app.db.session import SessionLocal

    if is_shutting_down():
        return

    db = SessionLocal()
    try:
        AIScreeningService(db).run_evaluation(org_id, screening_id)
    finally:
        db.close()


def _to_live_response(screening, msgs: list) -> LiveInterviewResponse:
    def _f(v):
        try:
            return float(v)
        except Exception:
            return None

    return LiveInterviewResponse(
        id=screening.id,
        candidate_id=screening.candidate_id,
        job_id=screening.job_id,
        status=screening.status,
        session_token=screening.session_token,
        livekit_room_name=screening.livekit_room_name,
        candidate_name_snapshot=screening.candidate_name_snapshot,
        job_title_snapshot=screening.job_title_snapshot,
        interview_mode=getattr(screening, "interview_mode", "async") or "async",
        overall_score=_f(screening.overall_score),
        recommendation=screening.recommendation,
        ai_summary=screening.ai_summary,
        strengths=screening.strengths,
        concerns=screening.concerns,
        salary_expectation=screening.salary_expectation,
        notice_period=screening.notice_period,
        career_goals=screening.career_goals,
        candidate_questions=getattr(screening, "candidate_questions", None),
        key_projects_mentioned=screening.key_projects_mentioned,
        communication_score=_f(screening.communication_score),
        experience_score=_f(getattr(screening, "experience_score", None)),
        confidence_score=_f(screening.confidence_score),
        culture_fit_score=_f(getattr(screening, "culture_fit_score", None)),
        leadership_score=_f(getattr(screening, "leadership_score", None)),
        duration_seconds=getattr(screening, "duration_seconds", None),
        started_at=screening.started_at.isoformat() if getattr(screening, "started_at", None) else None,
        ended_at=screening.ended_at.isoformat() if getattr(screening, "ended_at", None) else None,
        created_at=screening.created_at.isoformat(),
        incomplete_reason=getattr(screening, "incomplete_reason", None),
        expires_at=screening.expires_at.isoformat() if getattr(screening, "expires_at", None) else None,
        max_questions=getattr(screening, "max_questions", None),
        interview_duration_minutes=getattr(screening, "interview_duration_minutes", None),
        invitation_sent_at=screening.invitation_sent_at.isoformat() if getattr(screening, "invitation_sent_at", None) else None,
        invitation_email=getattr(screening, "invitation_email", None),
        recruiter_decision=getattr(screening, "recruiter_decision", None),
        recruiter_notes=getattr(screening, "recruiter_notes", None),
        video_url=getattr(screening, "video_url", None),
        audio_url=getattr(screening, "audio_url", None),
        messages=[
            LiveInterviewMessageSchema(
                id=str(m.id),
                role=m.role,
                content=m.content,
                sequence_number=m.sequence_number,
                question_number=m.question_number,
                is_followup=m.is_followup,
                created_at=m.created_at.isoformat(),
            )
            for m in msgs
        ],
    )

