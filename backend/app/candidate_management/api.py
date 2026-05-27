from __future__ import annotations

import logging
import os
import traceback
import json
import time
import html
from pathlib import Path
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile, status
from fastapi.responses import JSONResponse, FileResponse
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from app.candidate_management.ai_adapter import HttpAIService
from app.candidate_management.local_parser_adapter import (
    LocalParserWithAIFallback,
    LocalResumeParser,
)
from app.candidate_management.paths import (
    CANDIDATES_BULK_ASSIGN_RECRUITER,
    CANDIDATES_BULK_DELETE,
    CANDIDATES_BULK_UNARCHIVE,
    CANDIDATES_BULK_HARD_DELETE,
    CANDIDATES_BULK_STAGE,
)
from app.candidate_management.storage import SupabaseStorageClient
from app.candidate_management.schemas import (
    ApiResponse,
    BulkStageUpdateResponse,
    BulkUploadRequest,
    BulkUploadStatusResponse,
    CandidateAssignRecruiterRequest,
    CandidateBulkAssignRecruiterRequest,
    CandidateBulkDeleteRequest,
    CandidateBulkStageUpdateRequest,
    CandidateCreate,
    CandidateResponse,
    CandidateStatusSchema,
    CandidateUpdate,
    InteractionCreate,
    InteractionResponse,
    MergeCandidatesRequest,
    ResumeUploadRequest,
    ResumeUploadResponse,
)
from app.candidate_management.communication_schemas import (
    CommunicationConnectRequest,
    CommunicationConnectResponse,
    CommunicationConnectionStatus,
    CommunicationDisconnectRequest,
    CommunicationMessageResponse,
    CommunicationReminderCreate,
    CommunicationReminderResponse,
    CommunicationSendRequest,
    CommunicationTemplateCreate,
    CommunicationTemplateRenderRequest,
    CommunicationTemplateRenderResponse,
    CommunicationTemplateResponse,
    CommunicationTemplateUpdate,
    CommunicationWhatsAppSendRequest,
)
from app.candidate_management.communication_service import CommunicationService
from app.candidate_management.service import CandidateManagementService, SearchParams, TaskEnqueuerPort
from app.candidate_management.tasks import CeleryTaskEnqueuer
from app.core.dependencies import get_current_user, require_permission
from app.core.permissions import CANDIDATES_CREATE, CANDIDATES_DELETE, CANDIDATES_READ, CANDIDATES_UPDATE
from app.db.session import get_db
from app.schemas.candidate import CandidateCreate as LegacyCandidateCreate
from app.schemas.auth import CurrentUser
from app.schemas.interview import InterviewCreate, InterviewResponse, InterviewStatus, InterviewUpdate
from app.services.interview_service import InterviewService
from app.models.pipeline import Pipeline
from app.models.interview import Interview
from app.core.paths import append_debug_log
from app.services.candidate_service import CandidateService as LegacyCandidateService

router = APIRouter(tags=["candidate-management"])
logger = logging.getLogger(__name__)
_SIGNED_DOWNLOAD_TTL_SECONDS = 3600


def _debug_log(hypothesis_id: str, location: str, message: str, data: dict) -> None:
    append_debug_log(
        "debug-f65d2f.log",
        {
            "sessionId": "f65d2f",
            "runId": "pre-fix",
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data,
        },
    )


def _debug_log_7b7c67(hypothesis_id: str, location: str, message: str, data: dict) -> None:
    append_debug_log(
        "debug-7b7c67.log",
        {
            "sessionId": "7b7c67",
            "runId": "pre-fix",
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data,
        },
    )


class _NoopTaskEnqueuer(TaskEnqueuerPort):
    def enqueue_bulk_upload_item(self, *, job_id: UUID, item_id: UUID, org_id: UUID, workspace_id: UUID) -> None:
        return None


def _validate_resume_file_type(*, suffix: str, content_type: str | None) -> None:
    allowed_suffixes = {".pdf", ".docx"}
    allowed_mimes = {
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/msword",
    }
    if suffix not in allowed_suffixes:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only PDF and DOCX are supported.")
    if content_type and content_type.lower() not in allowed_mimes:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported MIME type for resume upload.")


def _workspace_id_header(x_workspace_id: str | None = Header(default=None, alias="X-Workspace-Id")) -> UUID:
    # region agent log
    _debug_log(
        "H5",
        "backend/app/candidate_management/api.py:_workspace_id_header",
        "Workspace header received",
        {"workspace_header_present": bool(x_workspace_id)},
    )
    # endregion
    if not x_workspace_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="X-Workspace-Id header is required.")
    try:
        return UUID(x_workspace_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid X-Workspace-Id.") from exc


def _log_list_interactions_failure(
    *,
    exc: BaseException,
    candidate_id: UUID,
    organization_id: UUID,
    workspace_id: UUID,
    degraded: bool,
) -> None:
    """Structured log for interaction timeline failures (no tokens or resume content)."""
    logger.error(
        "candidate_management.list_interactions_failed",
        extra={
            "candidate_id": str(candidate_id),
            "organization_id": str(organization_id),
            "workspace_id": str(workspace_id),
            "exception_class": type(exc).__name__,
            "degraded_to_empty": degraded,
        },
        exc_info=True,
    )


def _service(db: Session) -> CandidateManagementService:
    enqueuer: TaskEnqueuerPort
    try:
        enqueuer = CeleryTaskEnqueuer()
    except Exception:  # pragma: no cover - defensive fallback
        enqueuer = _NoopTaskEnqueuer()

    # Resume parsing: local-default with AI fallback only when an AI provider
    # is configured. We pass the DB session in so the local extractor can
    # union JobSkill rows into its skill catalogue.
    local_parser = LocalResumeParser(db=db)
    ai_fallback: HttpAIService | None = None
    if os.getenv("AI_SERVICES_URL") or os.getenv("GROQ_API_KEY") or os.getenv("GROQ_API_KEY_BACKUP"):
        try:
            ai_fallback = HttpAIService()
        except Exception:  # pragma: no cover - defensive
            ai_fallback = None
    parser_service = LocalParserWithAIFallback(local=local_parser, fallback=ai_fallback)

    return CandidateManagementService(
        db,
        ai_service=parser_service,
        task_enqueuer=enqueuer,
    )


def _success(data: Any) -> ApiResponse[Any]:
    return ApiResponse(success=True, data=data, error=None, details=None)


def _communication_service(db: Session) -> CommunicationService:
    return CommunicationService(db)


def _signed_resume_download_url(storage: SupabaseStorageClient, *, object_key: str) -> str | None:
    if not storage.is_configured():
        return None
    try:
        return storage.create_signed_download_url(
            object_key=object_key,
            expires_in_seconds=_SIGNED_DOWNLOAD_TTL_SECONDS,
        )
    except Exception:  # noqa: BLE001
        logger.warning("Failed to create signed resume URL for key=%s", object_key)
        return None


@router.post("/candidates", response_model=ApiResponse[CandidateResponse], status_code=status.HTTP_201_CREATED)
def create_candidate(
    payload: CandidateCreate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_CREATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[CandidateResponse]:
    service = _service(db)
    candidate = service.create_candidate(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
        payload=payload,
    )
    return _success(CandidateResponse.model_validate(candidate))


@router.post(CANDIDATES_BULK_STAGE, response_model=ApiResponse[BulkStageUpdateResponse], status_code=status.HTTP_200_OK)
def bulk_update_candidate_stage(
    payload: CandidateBulkStageUpdateRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[BulkStageUpdateResponse]:
    service = _service(db)
    updated_count = service.bulk_update_stage(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
        payload=payload,
    )
    return _success(BulkStageUpdateResponse(updated_count=updated_count))


@router.post(CANDIDATES_BULK_DELETE, response_model=ApiResponse[dict[str, Any]])
def bulk_delete_candidates(
    payload: CandidateBulkDeleteRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_DELETE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[dict[str, Any]]:
    service = _service(db)
    archived_count = service.bulk_soft_delete(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
        payload=payload,
    )
    return _success({"archived_count": archived_count, "deleted_count": archived_count})


@router.post(CANDIDATES_BULK_UNARCHIVE, response_model=ApiResponse[dict[str, Any]])
def bulk_unarchive_candidates(
    payload: CandidateBulkDeleteRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[dict[str, Any]]:
    service = _service(db)
    unarchived_count = service.bulk_unarchive(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
        payload=payload,
    )
    return _success({"unarchived_count": unarchived_count})


@router.post(CANDIDATES_BULK_HARD_DELETE, response_model=ApiResponse[dict[str, Any]])
def bulk_hard_delete_candidates(
    payload: CandidateBulkDeleteRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_DELETE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[dict[str, Any]]:
    service = _service(db)
    deleted_count = service.bulk_hard_delete(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
        payload=payload,
    )
    return _success({"deleted_count": deleted_count})


@router.post(CANDIDATES_BULK_ASSIGN_RECRUITER, response_model=ApiResponse[dict[str, Any]])
def bulk_assign_recruiter(
    payload: CandidateBulkAssignRecruiterRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[dict[str, Any]]:
    service = _service(db)
    updated_count = service.bulk_assign_recruiter(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
        payload=payload,
    )
    return _success({"updated_count": updated_count})


@router.post(
    "/candidates/upload-resume",
    response_model=ApiResponse[ResumeUploadResponse],
    status_code=status.HTTP_201_CREATED,
)
def upload_resume(
    payload: ResumeUploadRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_CREATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[ResumeUploadResponse]:
    service = _service(db)
    candidate, parse_result = service.create_candidate_from_resume(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
        request=payload,
    )
    storage = SupabaseStorageClient()
    download_url = _signed_resume_download_url(storage, object_key=payload.resume_s3_key)
    return _success(
        ResumeUploadResponse(
            candidate=CandidateResponse.model_validate(candidate),
            parse_result=parse_result,
            resume_download_url=download_url,
        )
    )


@router.post(
    "/candidates/parse-resume-file",
    response_model=ApiResponse[dict[str, Any]],
    status_code=status.HTTP_200_OK,
)
async def parse_resume_file(
    file: UploadFile = File(...),
    _: CurrentUser = Depends(require_permission(CANDIDATES_CREATE)),
    current_user: CurrentUser = Depends(get_current_user),
    workspace_id: UUID = Depends(_workspace_id_header),
) -> ApiResponse[dict[str, Any]]:
    suffix = Path(file.filename or "resume").suffix.lower()
    _validate_resume_file_type(suffix=suffix, content_type=file.content_type)
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="File exceeds 10MB limit.")

    storage_root = Path(os.getenv("CANDIDATE_RESUME_UPLOAD_DIR", "tmp/candidate-resumes"))
    storage_root.mkdir(parents=True, exist_ok=True)
    safe_name = file.filename or "resume"
    candidate_stub = uuid4()
    generated_key = f"resumes/{current_user.organization_id}/{candidate_stub}/{safe_name}"
    destination = storage_root / generated_key.replace("/", "_")
    destination.write_bytes(content)
    storage = SupabaseStorageClient()
    if storage.is_configured():
        try:
            storage.upload_bytes(
                object_key=generated_key,
                content=content,
                content_type=file.content_type,
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Resume storage upload failed: {exc}") from exc

    ai = LocalParserWithAIFallback(local=LocalResumeParser(), fallback=HttpAIService())
    parse_result = ai.parse_resume(resume_s3_key=generated_key)
    parsed = parse_result.parsed_resume_data or {}
    draft = {
        "first_name": str(parsed.get("first_name") or ""),
        "last_name": str(parsed.get("last_name") or ""),
        "email": str(parsed.get("email") or ""),
        "phone": str(parsed.get("phone") or ""),
        "location": str(parsed.get("location") or ""),
        "headline": str(parsed.get("headline") or ""),
        "years_experience": parsed.get("years_experience"),
        "summary": str(parsed.get("summary") or ""),
        "resume_s3_key": generated_key,
        "resume_file_name": safe_name,
        "workspace_id": str(workspace_id),
        "resume_download_url": _signed_resume_download_url(storage, object_key=generated_key),
    }
    return _success({"draft": draft, "parse_result": parse_result.model_dump()})


@router.post(
    "/candidates/upload-resume-file",
    response_model=ApiResponse[ResumeUploadResponse],
    status_code=status.HTTP_201_CREATED,
)
async def upload_resume_file(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_permission(CANDIDATES_CREATE)),
    current_user: CurrentUser = Depends(get_current_user),
    workspace_id: UUID = Depends(_workspace_id_header),
) -> ApiResponse[ResumeUploadResponse]:
    suffix = Path(file.filename or "resume").suffix.lower()
    _validate_resume_file_type(suffix=suffix, content_type=file.content_type)
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="File exceeds 10MB limit.")

    storage_root = Path(os.getenv("CANDIDATE_RESUME_UPLOAD_DIR", "tmp/candidate-resumes"))
    storage_root.mkdir(parents=True, exist_ok=True)
    safe_name = file.filename or "resume"
    candidate_stub = uuid4()
    generated_key = f"resumes/{current_user.organization_id}/{candidate_stub}/{safe_name}"
    destination = storage_root / generated_key.replace("/", "_")
    destination.write_bytes(content)
    storage = SupabaseStorageClient()
    if storage.is_configured():
        try:
            storage.upload_bytes(
                object_key=generated_key,
                content=content,
                content_type=file.content_type,
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Resume storage upload failed: {exc}") from exc

    ai = LocalParserWithAIFallback(local=LocalResumeParser(db=db), fallback=HttpAIService())
    parse_result = ai.parse_resume(resume_s3_key=generated_key)

    has_new_schema = bool(
        db.execute(
            text(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_name='candidates' AND column_name='org_id'
                LIMIT 1
                """
            )
        ).scalar()
    )

    if has_new_schema:
        service = _service(db)
        candidate, parse_result = service.create_candidate_from_resume(
            org_id=UUID(current_user.organization_id),
            workspace_id=workspace_id,
            actor_user_id=UUID(current_user.user_id),
            actor_role=current_user.role,
            request=ResumeUploadRequest(
                candidate_id=candidate_stub,
                resume_s3_key=generated_key,
                resume_file_name=safe_name,
            ),
        )
    else:
        parsed = parse_result.parsed_resume_data or {}
        legacy_service = LegacyCandidateService(db)
        legacy_candidate = legacy_service.create_candidate(
            UUID(current_user.organization_id),
            LegacyCandidateCreate(
                first_name=str(parsed.get("first_name") or "Unknown"),
                last_name=str(parsed.get("last_name") or "Candidate"),
                email=str(parsed.get("email") or f"unknown-{UUID(current_user.user_id)}@example.com"),
                phone=parsed.get("phone"),
                location=parsed.get("location"),
                experience_summary=(
                    f"{parsed.get('years_experience')} years" if parsed.get("years_experience") is not None else None
                ),
                education=None,
                notes=f"ROLE:{parsed.get('headline')}" if parsed.get("headline") else None,
            ),
        )
        candidate = CandidateResponse(
            id=legacy_candidate.id,
            org_id=UUID(current_user.organization_id),
            workspace_id=workspace_id,
            first_name=legacy_candidate.first_name,
            last_name=legacy_candidate.last_name,
            full_name=f"{legacy_candidate.first_name} {legacy_candidate.last_name}".strip(),
            email=legacy_candidate.email,
            phone=legacy_candidate.phone,
            location=legacy_candidate.location,
            years_experience=parsed.get("years_experience"),
            headline=parsed.get("headline"),
            summary=legacy_candidate.experience_summary,
            source="resume_upload",
            status="active",
            resume_s3_key=generated_key,
            resume_file_name=safe_name,
            resume_uploaded_at=None,
            ai_parse_version=parse_result.ai_parse_version,
            parse_confidence=parse_result.parse_confidence,
            parsed_resume_data=parse_result.parsed_resume_data,
            merged_into_candidate_id=None,
            merged_at=None,
            created_by=UUID(current_user.user_id),
            updated_by=UUID(current_user.user_id),
            deleted_by=None,
            created_at=legacy_candidate.created_at,
            updated_at=legacy_candidate.updated_at,
            deleted_at=None,
            skills=[],
            stage="applied",
            job_id=None,
            recruiter_id=None,
        )
    return _success(
        ResumeUploadResponse(
            candidate=CandidateResponse.model_validate(candidate),
            parse_result=parse_result,
            resume_download_url=_signed_resume_download_url(storage, object_key=generated_key),
        )
    )


@router.get("/candidates/{candidate_id}", response_model=ApiResponse[CandidateResponse])
def get_candidate(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
):
    try:
        service = _service(db)
        candidate = service.get_candidate(
            org_id=UUID(current_user.organization_id),
            workspace_id=workspace_id,
            candidate_id=candidate_id,
        )
        # Use robust normalization to prevent validation errors on detail view
        safe_data = service._normalize_candidate(candidate)
        return _success(CandidateResponse.model_validate(safe_data))
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND:
            try:
                legacy_service = LegacyCandidateService(db)
                legacy_candidate = legacy_service.get_candidate_by_id(
                    candidate_id,
                    UUID(current_user.organization_id),
                    current_user,
                    include_archived=True,
                )
                candidate_resp = CandidateResponse(
                    id=legacy_candidate.id,
                    org_id=UUID(current_user.organization_id),
                    workspace_id=workspace_id,
                    first_name=legacy_candidate.first_name,
                    last_name=legacy_candidate.last_name,
                    full_name=f"{legacy_candidate.first_name} {legacy_candidate.last_name}".strip(),
                    email=legacy_candidate.email,
                    phone=legacy_candidate.phone,
                    location=legacy_candidate.location,
                    years_experience=None,
                    headline=None,
                    summary=legacy_candidate.experience_summary,
                    source="unknown",
                    status="active",
                    resume_s3_key=None,
                    resume_file_name=None,
                    resume_uploaded_at=None,
                    ai_parse_version=None,
                    parse_confidence=None,
                    parsed_resume_data=None,
                    merged_into_candidate_id=None,
                    merged_at=None,
                    created_by=legacy_candidate.created_by,
                    updated_by=legacy_candidate.created_by,
                    deleted_by=None,
                    created_at=legacy_candidate.created_at,
                    updated_at=legacy_candidate.updated_at,
                    deleted_at=None,
                    skills=[],
                    stage="applied",
                    job_id=None,
                    recruiter_id=None,
                )
                return _success(candidate_resp)
            except HTTPException as e2:
                if e2.status_code == status.HTTP_404_NOT_FOUND:
                    raise HTTPException(status_code=404, detail="Candidate not found")
                raise e2
        raise
    except Exception as e:
        logger.error(f"FATAL: Internal error in get_candidate for {candidate_id}: {str(e)}")
        logger.error(traceback.format_exc())
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": "Internal server error",
                "detail": str(e),
                "hint": "Check backend logs for detailed traceback"
            }
        )



@router.get("/candidates/{candidate_id}/resume")
def download_candidate_resume(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
    disposition: Annotated[str, Query(pattern="^(inline|attachment)$")] = "attachment",
):
    """Serve or download the candidate resume file stored locally."""
    service = _service(db)
    candidate = service.get_candidate(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        candidate_id=candidate_id,
    )
    if not candidate.resume_s3_key:
        raise HTTPException(status_code=404, detail="No resume found for this candidate.")
    
    storage_root = Path(os.getenv("CANDIDATE_RESUME_UPLOAD_DIR", "tmp/candidate-resumes"))
    # The upload logic uses .replace("/", "_")
    file_path = storage_root / candidate.resume_s3_key.replace("/", "_")
    
    if not file_path.exists():
         # Fallback to literal path if underscore replacement wasn't used
         file_path = storage_root / candidate.resume_s3_key
         if not file_path.exists():
             logger.error(f"Resume file not found at {file_path} for candidate {candidate_id}")
             raise HTTPException(status_code=404, detail="Resume file not found on server.")
         
    file_name = (candidate.resume_file_name or "").lower()
    if file_name.endswith(".pdf"):
        media_type = "application/pdf"
    elif file_name.endswith(".docx"):
        media_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    elif file_name.endswith(".doc"):
        media_type = "application/msword"
    else:
        media_type = "application/octet-stream"

    return FileResponse(
        path=file_path,
        filename=candidate.resume_file_name or "resume.pdf",
        media_type=media_type,
        content_disposition_type=disposition,
    )


@router.get("/candidates/{candidate_id}/resume/preview")
def preview_candidate_resume(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
):
    """Return styled HTML preview for formats browsers don't inline render."""
    service = _service(db)
    candidate = service.get_candidate(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        candidate_id=candidate_id,
    )
    if not candidate.resume_s3_key:
        raise HTTPException(status_code=404, detail="No resume found for this candidate.")

    storage_root = Path(os.getenv("CANDIDATE_RESUME_UPLOAD_DIR", "tmp/candidate-resumes"))
    file_path = storage_root / candidate.resume_s3_key.replace("/", "_")
    if not file_path.exists():
        file_path = storage_root / candidate.resume_s3_key
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="Resume file not found on server.")

    name = (candidate.resume_file_name or file_path.name).lower()
    if name.endswith(".docx"):
        from app.documents.docx_html_preview import docx_body_html_from_path, wrap_document_preview_html

        body_html = docx_body_html_from_path(file_path)
        html_doc = wrap_document_preview_html(
            title="Resume preview",
            display_name=candidate.resume_file_name or file_path.name,
            body_html=body_html,
        )
    elif name.endswith(".doc"):
        body_html = (
            "<p>Preview for .doc is limited.</p>"
            "<p>Please use <strong>Download</strong> to view the original file in Word for full fidelity.</p>"
        )
        from app.documents.docx_html_preview import wrap_document_preview_html

        html_doc = wrap_document_preview_html(
            title="Resume preview",
            display_name=candidate.resume_file_name or file_path.name,
            body_html=body_html,
        )
    else:
        body_html = "<p>Inline preview is available for DOCX. Use Open for PDF or Download for other formats.</p>"
        from app.documents.docx_html_preview import wrap_document_preview_html

        html_doc = wrap_document_preview_html(
            title="Resume preview",
            display_name=candidate.resume_file_name or file_path.name,
            body_html=body_html,
        )

    return {
        "file_name": candidate.resume_file_name or file_path.name,
        "html": html_doc,
    }


@router.get("/candidates", response_model=ApiResponse[dict[str, Any]])
def list_candidates(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
    limit: Annotated[int, Query(ge=1, le=1000)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    skills: Annotated[list[str] | None, Query()] = None,
    location: str | None = None,
    min_years_experience: Annotated[int | None, Query(ge=0)] = None,
    max_years_experience: Annotated[int | None, Query(ge=0)] = None,
    query: str | None = None,
    search_mode: Annotated[
        str,
        Query(description="fast (default, indexed DB search) or semantic (AI-ranked, slower)"),
    ] = "fast",
    status_filter: Annotated[CandidateStatusSchema | None, Query(alias="status")] = None,
    stage: str | None = None,
    source: str | None = None,
    job_id: UUID | None = None,
    candidate_ids: Annotated[list[UUID] | None, Query()] = None,
) -> ApiResponse[dict[str, Any]]:
    service = _service(db)
    candidates, total = service.search_candidates(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        params=SearchParams(
            query=query,
            search_mode=search_mode,
            skills=skills,
            location=location,
            min_years_experience=min_years_experience,
            max_years_experience=max_years_experience,
            status=status_filter.value if status_filter else None,
            stage=stage,
            source=source,
            job_id=job_id,
            candidate_ids=candidate_ids,
            limit=limit,
            offset=offset,
        ),
    )
    return _success(
        {
            "candidates": [
                CandidateResponse.model_validate(service.candidate_to_response_dict(item, list_mode=True))
                for item in candidates
            ],
            "total_count": total,
            "limit": limit,
            "offset": offset,
        }
    )


@router.patch("/candidates/{candidate_id}", response_model=ApiResponse[CandidateResponse])
def update_candidate(
    candidate_id: UUID,
    payload: CandidateUpdate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[CandidateResponse]:
    service = _service(db)
    candidate = service.update_candidate(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        candidate_id=candidate_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
        payload=payload,
    )
    return _success(CandidateResponse.model_validate(candidate))


@router.post("/candidates/{candidate_id}/assign-recruiter", response_model=ApiResponse[CandidateResponse])
def assign_candidate_recruiter(
    candidate_id: UUID,
    payload: CandidateAssignRecruiterRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[CandidateResponse]:
    service = _service(db)
    candidate = service.assign_recruiter(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        candidate_id=candidate_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
        payload=payload,
    )
    return _success(CandidateResponse.model_validate(candidate))


@router.post("/candidates/{candidate_id}/archive", response_model=ApiResponse[dict[str, Any]])
def archive_candidate(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_DELETE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[dict[str, Any]]:
    """AIR-510: Archive (soft-delete) — is_deleted, deleted_at, deleted_by; row retained."""
    service = _service(db)
    service.archive_candidate(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        candidate_id=candidate_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
    )
    return _success({"archived": True, "candidate_id": str(candidate_id)})


@router.delete("/candidates/{candidate_id}", response_model=ApiResponse[dict[str, Any]])
def delete_candidate(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_DELETE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[dict[str, Any]]:
    """Permanent hard delete — unchanged GDPR/cleanup behavior."""
    service = _service(db)
    service.hard_delete_candidate(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        candidate_id=candidate_id,
    )
    return _success({"deleted": True, "hard_deleted": True, "candidate_id": str(candidate_id)})


@router.patch("/candidates/{candidate_id}/restore", response_model=ApiResponse[CandidateResponse])
def restore_candidate(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[CandidateResponse]:
    """AIR-512: Admin restore — sets is_deleted=false and clears deleted_at."""
    service = _service(db)
    candidate = service.restore_candidate(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        candidate_id=candidate_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
    )
    return _success(CandidateResponse.model_validate(candidate))


@router.post("/candidates/merge", response_model=ApiResponse[CandidateResponse])
def merge_candidates(
    payload: MergeCandidatesRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[CandidateResponse]:
    service = _service(db)
    merged = service.merge_candidates(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
        payload=payload,
    )
    return _success(CandidateResponse.model_validate(merged))


@router.post(
    "/candidates/{candidate_id}/interactions",
    response_model=ApiResponse[InteractionResponse],
    status_code=status.HTTP_201_CREATED,
)
def add_interaction(
    candidate_id: UUID,
    payload: InteractionCreate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[InteractionResponse]:
    service = _service(db)
    interaction = service.add_interaction(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        candidate_id=candidate_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
        payload=payload,
    )
    normalized = service._normalize_interaction(interaction)
    return _success(InteractionResponse.model_validate(normalized))


@router.get("/candidates/{candidate_id}/interactions", response_model=ApiResponse[list[InteractionResponse]])
def list_interactions(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ApiResponse[list[InteractionResponse]]:
    org_id = UUID(current_user.organization_id)
    try:
        service = _service(db)
        interactions = service.get_timeline(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate_id,
            limit=limit,
            offset=offset,
        )
        validated: list[InteractionResponse] = []
        for item in interactions:
            try:
                normalized = service._normalize_interaction(item)
                validated.append(InteractionResponse.model_validate(normalized))
            except (ValidationError, TypeError, ValueError) as row_exc:
                logger.warning(
                    "candidate_management.interaction_row_skipped",
                    extra={
                        "candidate_id": str(candidate_id),
                        "organization_id": str(org_id),
                        "interaction_id": str(getattr(item, "id", "")),
                        "exception_class": type(row_exc).__name__,
                    },
                    exc_info=True,
                )
        return _success(validated)
    except HTTPException:
        raise
    except (ProgrammingError, OperationalError) as exc:
        _log_list_interactions_failure(
            exc=exc,
            candidate_id=candidate_id,
            organization_id=org_id,
            workspace_id=workspace_id,
            degraded=True,
        )
        return _success([])
    except Exception as exc:
        _log_list_interactions_failure(
            exc=exc,
            candidate_id=candidate_id,
            organization_id=org_id,
            workspace_id=workspace_id,
            degraded=True,
        )
        return _success([])


@router.post("/communication/oauth/connect", response_model=ApiResponse[CommunicationConnectResponse])
def communication_oauth_connect(
    payload: CommunicationConnectRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[CommunicationConnectResponse]:
    service = _communication_service(db)
    state = service.build_oauth_state(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        user_id=UUID(current_user.user_id),
        provider=payload.provider,
    )
    auth_url = service.build_authorization_url(provider=payload.provider, state=state)
    return _success(
        CommunicationConnectResponse(
            provider=payload.provider,
            authorization_url=auth_url,
            state=state,
        )
    )


@router.get("/communication/oauth/callback", response_model=ApiResponse[CommunicationConnectionStatus])
def communication_oauth_callback(
    code: str,
    state: str,
    db: Annotated[Session, Depends(get_db)],
    provider: str | None = None,
) -> ApiResponse[CommunicationConnectionStatus]:
    service = _communication_service(db)
    conn = service.upsert_oauth_connection(code=code, state=state, provider_override=provider)
    return _success(CommunicationConnectionStatus.model_validate(conn))


@router.get("/communication/connections", response_model=ApiResponse[list[CommunicationConnectionStatus]])
def communication_connections(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[list[CommunicationConnectionStatus]]:
    try:
        service = _communication_service(db)
        rows = service.list_connections(
            org_id=UUID(current_user.organization_id),
            workspace_id=workspace_id,
            user_id=UUID(current_user.user_id),
        )
        return _success([CommunicationConnectionStatus.model_validate(item) for item in rows])
    except (ProgrammingError, OperationalError):
        logger.warning("communication.connections_unavailable", exc_info=True)
        return _success([])


@router.post("/communication/disconnect", response_model=ApiResponse[dict[str, bool]])
def communication_disconnect(
    payload: CommunicationDisconnectRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[dict[str, bool]]:
    service = _communication_service(db)
    service.disconnect(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        user_id=UUID(current_user.user_id),
        provider=payload.provider,
    )
    return _success({"disconnected": True})


@router.get("/communication/templates", response_model=ApiResponse[list[CommunicationTemplateResponse]])
def communication_list_templates(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
    channel: str = "email",
    search: str | None = None,
    category: str | None = None,
) -> ApiResponse[list[CommunicationTemplateResponse]]:
    # region agent log
    _debug_log_7b7c67(
        "H1,H2,H3,H4",
        "backend/app/candidate_management/api.py:communication_list_templates:entry",
        "Template list request entered",
        {
            "workspace_id_present": bool(workspace_id),
            "organization_id_present": bool(current_user.organization_id),
            "user_id_present": bool(current_user.user_id),
            "channel": channel,
            "search_present": bool(search),
            "category": category,
        },
    )
    # endregion
    try:
        service = _communication_service(db)
        service.seed_default_templates(
            org_id=UUID(current_user.organization_id),
            workspace_id=workspace_id,
            user_id=UUID(current_user.user_id),
        )
        # region agent log
        _debug_log_7b7c67(
            "H1,H2",
            "backend/app/candidate_management/api.py:communication_list_templates:after_seed",
            "Default template seed completed",
            {"channel": channel},
        )
        # endregion
        rows = service.list_templates(
            org_id=UUID(current_user.organization_id),
            workspace_id=workspace_id,
            channel=channel,
            search=search,
            category=category,
        )
        # region agent log
        _debug_log_7b7c67(
            "H2,H3,H4",
            "backend/app/candidate_management/api.py:communication_list_templates:after_query",
            "Template query returned rows",
            {
                "row_count": len(rows),
                "sample": [
                    {
                        "id": str(item.id),
                        "name": item.name,
                        "channel": item.channel,
                        "placeholders_type": type(item.placeholders).__name__,
                        "placeholders_is_none": item.placeholders is None,
                        "is_deleted": item.is_deleted,
                    }
                    for item in rows[:3]
                ],
            },
        )
        # endregion
        response_rows = [CommunicationTemplateResponse.model_validate(item) for item in rows]
        # region agent log
        _debug_log_7b7c67(
            "H3",
            "backend/app/candidate_management/api.py:communication_list_templates:after_validate",
            "Template response validation completed",
            {"response_count": len(response_rows)},
        )
        # endregion
        return _success(response_rows)
    except (ProgrammingError, OperationalError) as exc:
        db.rollback()
        # region agent log
        _debug_log_7b7c67(
            "H1",
            "backend/app/candidate_management/api.py:communication_list_templates:db_unavailable",
            "Template database query failed with schema/connectivity error",
            {"error_type": type(exc).__name__, "error": str(exc), "traceback": traceback.format_exc()},
        )
        # endregion
        logger.warning("communication.templates_unavailable", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Communication templates database schema is unavailable. Run database migrations.",
        ) from exc
    except ValidationError as exc:
        # region agent log
        _debug_log_7b7c67(
            "H3",
            "backend/app/candidate_management/api.py:communication_list_templates:validation_error",
            "Template response validation failed",
            {"errors": exc.errors(), "traceback": traceback.format_exc()},
        )
        # endregion
        raise
    except Exception as exc:
        # region agent log
        _debug_log_7b7c67(
            "H2,H4",
            "backend/app/candidate_management/api.py:communication_list_templates:unexpected_error",
            "Template list failed unexpectedly",
            {"error_type": type(exc).__name__, "error": str(exc), "traceback": traceback.format_exc()},
        )
        # endregion
        raise


@router.post("/communication/templates", response_model=ApiResponse[CommunicationTemplateResponse])
def communication_create_template(
    payload: CommunicationTemplateCreate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[CommunicationTemplateResponse]:
    service = _communication_service(db)
    row = service.create_template(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        user_id=UUID(current_user.user_id),
        channel=payload.channel,
        provider=payload.provider,
        name=payload.name,
        category=payload.category,
        subject_template=payload.subject_template,
        body_template=payload.body_template,
    )
    return _success(CommunicationTemplateResponse.model_validate(row))


@router.post("/communication/templates/{template_id}/duplicate", response_model=ApiResponse[CommunicationTemplateResponse])
def communication_duplicate_template(
    template_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[CommunicationTemplateResponse]:
    service = _communication_service(db)
    row = service.duplicate_template(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        user_id=UUID(current_user.user_id),
        template_id=template_id,
    )
    return _success(CommunicationTemplateResponse.model_validate(row))


@router.patch("/communication/templates/{template_id}", response_model=ApiResponse[CommunicationTemplateResponse])
def communication_update_template(
    template_id: UUID,
    payload: CommunicationTemplateUpdate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[CommunicationTemplateResponse]:
    service = _communication_service(db)
    row = service.update_template(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        user_id=UUID(current_user.user_id),
        template_id=template_id,
        payload=payload.model_dump(exclude_unset=True),
    )
    return _success(CommunicationTemplateResponse.model_validate(row))


@router.post("/communication/templates/render", response_model=ApiResponse[CommunicationTemplateRenderResponse])
def communication_render_template(
    payload: CommunicationTemplateRenderRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[CommunicationTemplateRenderResponse]:
    service = _communication_service(db)
    subject, body, unresolved = service.render_template(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        template_id=payload.template_id,
        values=payload.values,
    )
    return _success(
        CommunicationTemplateRenderResponse(
            subject=subject,
            body=body,
            unresolved_placeholders=unresolved,
        )
    )


@router.post(
    "/candidates/{candidate_id}/communication/send-email",
    response_model=ApiResponse[CommunicationMessageResponse],
)
def communication_send_email(
    candidate_id: UUID,
    payload: CommunicationSendRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[CommunicationMessageResponse]:
    service = _communication_service(db)
    row = service.send_email(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        user_id=UUID(current_user.user_id),
        candidate_id=candidate_id,
        provider=payload.provider,
        to_email=payload.to_email,
        subject=payload.subject,
        body=payload.body,
        save_as_draft=payload.save_as_draft,
        quick_action=payload.quick_action,
        attachments=payload.attachments,
        template_id=payload.template_id,
        template_values=payload.template_values,
        idempotency_key=payload.idempotency_key,
    )
    return _success(CommunicationMessageResponse.model_validate(row))


@router.post(
    "/candidates/{candidate_id}/communication/send-whatsapp",
    response_model=ApiResponse[CommunicationMessageResponse],
)
def communication_send_whatsapp(
    candidate_id: UUID,
    payload: CommunicationWhatsAppSendRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[CommunicationMessageResponse]:
    try:
        service = _communication_service(db)
        row = service.send_whatsapp_message(
            org_id=UUID(current_user.organization_id),
            workspace_id=workspace_id,
            user_id=UUID(current_user.user_id),
            candidate_id=candidate_id,
            to_phone=payload.to_phone,
            body=payload.body or "",
            template_id=payload.template_id,
            template_values=payload.template_values,
            idempotency_key=payload.idempotency_key,
            quick_action=payload.quick_action,
        )
        return _success(CommunicationMessageResponse.model_validate(row))
    except (ProgrammingError, OperationalError):
        logger.warning("communication.send_whatsapp_unavailable", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Communication backend is not fully set up yet. Please reconnect provider or run migrations.",
        ) from None


@router.get(
    "/candidates/{candidate_id}/communication/messages",
    response_model=ApiResponse[list[CommunicationMessageResponse]],
)
def communication_messages(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> ApiResponse[list[CommunicationMessageResponse]]:
    try:
        service = _communication_service(db)
        rows = service.list_messages(
            org_id=UUID(current_user.organization_id),
            workspace_id=workspace_id,
            candidate_id=candidate_id,
            limit=limit,
        )
        return _success([CommunicationMessageResponse.model_validate(item) for item in rows])
    except (ProgrammingError, OperationalError):
        logger.warning("communication.messages_unavailable", exc_info=True)
        return _success([])


@router.post(
    "/candidates/{candidate_id}/communication/reminders",
    response_model=ApiResponse[CommunicationReminderResponse],
)
def communication_create_reminder(
    candidate_id: UUID,
    payload: CommunicationReminderCreate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[CommunicationReminderResponse]:
    service = _communication_service(db)
    row = service.create_reminder(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        user_id=UUID(current_user.user_id),
        candidate_id=candidate_id,
        channel=payload.channel,
        provider=payload.provider,
        to_address=payload.to_address,
        subject=payload.subject,
        body=payload.body,
        template_id=payload.template_id,
        template_values=payload.template_values,
        scheduled_for=payload.scheduled_for,
    )
    return _success(CommunicationReminderResponse.model_validate(row))


@router.get(
    "/candidates/{candidate_id}/communication/reminders",
    response_model=ApiResponse[list[CommunicationReminderResponse]],
)
def communication_list_reminders(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[list[CommunicationReminderResponse]]:
    try:
        service = _communication_service(db)
        rows = service.list_reminders(
            org_id=UUID(current_user.organization_id),
            workspace_id=workspace_id,
            candidate_id=candidate_id,
        )
        return _success([CommunicationReminderResponse.model_validate(item) for item in rows])
    except (ProgrammingError, OperationalError):
        logger.warning("communication.reminders_unavailable", exc_info=True)
        return _success([])


@router.post("/communication/reminders/run-due", response_model=ApiResponse[dict[str, int]])
def communication_run_due_reminders(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[dict[str, int]]:
    service = _communication_service(db)
    processed = service.process_due_reminders(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        user_id=UUID(current_user.user_id),
    )
    return _success({"processed": processed})


@router.post("/bulk-upload", response_model=ApiResponse[BulkUploadStatusResponse], status_code=status.HTTP_202_ACCEPTED)
def create_bulk_upload(
    payload: BulkUploadRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_CREATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[BulkUploadStatusResponse]:
    service = _service(db)
    job = service.create_bulk_upload_job(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        actor_user_id=UUID(current_user.user_id),
        request=payload,
    )
    return _success(BulkUploadStatusResponse.model_validate(job))


@router.get("/bulk-upload/{job_id}", response_model=ApiResponse[BulkUploadStatusResponse])
def get_bulk_upload_status(
    job_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[BulkUploadStatusResponse]:
    service = _service(db)
    job = service.get_bulk_upload_job(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        job_id=job_id,
    )
    return _success(BulkUploadStatusResponse.model_validate(job))


@router.post("/interviews", response_model=ApiResponse[InterviewResponse], status_code=status.HTTP_201_CREATED)
def create_interview_bridge(
    payload: dict[str, Any],
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[InterviewResponse]:
    candidate_id = UUID(str(payload.get("candidate_id")))
    service = _service(db)
    candidate = service.get_candidate(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        candidate_id=candidate_id,
    )
    job_id = payload.get("job_id") or (str(candidate.job_id) if candidate.job_id else None)
    if not job_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="job_id is required.")
    job_uuid = UUID(str(job_id))

    pipeline = db.scalar(
        select(Pipeline).where(
            Pipeline.organization_id == UUID(current_user.organization_id),
            Pipeline.candidate_id == candidate_id,
            Pipeline.job_id == job_uuid,
        )
    )
    if pipeline is None:
        service.update_candidate(
            org_id=UUID(current_user.organization_id),
            workspace_id=workspace_id,
            candidate_id=candidate_id,
            actor_user_id=UUID(current_user.user_id),
            actor_role=current_user.role,
            payload=CandidateUpdate(job_id=job_uuid, stage=candidate.stage),
        )
        pipeline = db.scalar(
            select(Pipeline).where(
                Pipeline.organization_id == UUID(current_user.organization_id),
                Pipeline.candidate_id == candidate_id,
                Pipeline.job_id == job_uuid,
            )
        )
    if pipeline is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Unable to create pipeline bridge.")

    interview_service = InterviewService(db)
    interview = interview_service.create_interview(
        UUID(current_user.organization_id),
        current_user,
        InterviewCreate(
            pipeline_id=pipeline.id,
            scheduled_at=payload["scheduled_at"],
            status=InterviewStatus(payload.get("status", "scheduled")),
            interviewer_name=payload.get("interviewer_name"),
            notes=payload.get("feedback"),
        ),
    )
    service.add_interaction(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        candidate_id=candidate_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
        payload=InteractionCreate(
            interaction_type="interview",
            title="Interview scheduled",
            interaction_metadata={
                "action": "created",
                "interview_id": str(interview.id),
                "interview_type": payload.get("interview_type"),
                "rating": payload.get("rating"),
                "status": interview.status,
            },
        ),
    )
    return _success(InterviewResponse.model_validate(interview))


@router.get("/candidates/{candidate_id}/interviews", response_model=ApiResponse[list[InterviewResponse]])
def list_candidate_interviews(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> ApiResponse[list[InterviewResponse]]:
    pipelines = list(
        db.scalars(
            select(Pipeline).where(
                Pipeline.organization_id == UUID(current_user.organization_id),
                Pipeline.candidate_id == candidate_id,
            )
        )
    )
    if not pipelines:
        return _success([])
    pipeline_ids = {pipe.id for pipe in pipelines}
    
    interviews = list(
        db.scalars(
            select(Interview).where(
                Interview.organization_id == UUID(current_user.organization_id),
                Interview.pipeline_id.in_(pipeline_ids)
            )
        )
    )
    return _success([InterviewResponse.model_validate(item) for item in interviews])


@router.patch("/interviews/{interview_id}", response_model=ApiResponse[InterviewResponse])
def update_interview_bridge(
    interview_id: UUID,
    payload: dict[str, Any],
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    workspace_id: Annotated[UUID, Depends(_workspace_id_header)],
) -> ApiResponse[InterviewResponse]:
    interview_service = InterviewService(db)
    interview = interview_service.get_interview_by_id(interview_id, UUID(current_user.organization_id), current_user)
    updated = interview_service.update_interview(
        interview_id=interview_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
        payload=InterviewUpdate(
            scheduled_at=payload.get("scheduled_at"),
            status=InterviewStatus(payload["status"]) if payload.get("status") else None,
            interviewer_name=payload.get("interviewer_name"),
            notes=payload.get("notes"),
        ),
    )

    pipeline = db.scalar(
        select(Pipeline).where(
            Pipeline.id == updated.pipeline_id,
            Pipeline.organization_id == UUID(current_user.organization_id),
        )
    )
    if pipeline is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pipeline not found for interview.")

    action = "updated"
    if payload.get("status") == "cancelled":
        action = "cancelled"
    elif payload.get("scheduled_at"):
        action = "rescheduled"
    elif payload.get("notes") or payload.get("rating") is not None:
        action = "feedback_updated"

    service = _service(db)
    service.add_interaction(
        org_id=UUID(current_user.organization_id),
        workspace_id=workspace_id,
        candidate_id=pipeline.candidate_id,
        actor_user_id=UUID(current_user.user_id),
        actor_role=current_user.role,
        payload=InteractionCreate(
            interaction_type="interview",
            title=f"Interview {action}",
            interaction_metadata={
                "action": action,
                "interview_id": str(updated.id),
                "status": updated.status,
                "scheduled_at": updated.scheduled_at.isoformat(),
                "interviewer_name": updated.interviewer_name,
                "interview_type": payload.get("interview_type"),
                "rating": payload.get("rating"),
            },
            body=payload.get("notes"),
        ),
    )
    return _success(InterviewResponse.model_validate(updated))

