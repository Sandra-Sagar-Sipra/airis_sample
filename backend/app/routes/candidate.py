from __future__ import annotations

import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user, require_any_permissions, require_permission
from app.core.permissions import (
    ATS_READ,
    ATS_RESCORE,
    CANDIDATES_CREATE,
    CANDIDATES_DELETE,
    CANDIDATES_MERGE,
    CANDIDATES_READ,
    CANDIDATES_READ_OWN,
    CANDIDATES_UPDATE,
)
from app.db.session import get_db
from app.schemas.auth import CurrentUser
from app.schemas.candidate import CandidateCreate, CandidateResponse, CandidateUpdate
from app.schemas.candidate_dedup import DuplicateCheckRequest, DuplicateCheckResult, DuplicateMatchOut, MergeRequest, MergeResponse
from app.services.candidate_service import CandidateService
from app.services.candidate_dedup.detection_service import DuplicateDetectionService
from app.services.candidate_dedup.merge_service import CandidateMergeService
from app.services.job_service import JobService
from app.schemas.job import AtsCandidateRescoreResponse, CandidateMatchesResponse
from app.schemas.placement_history import CandidatePlacementListResponse
from app.services.placement_history_service import PlacementHistoryService
logger = logging.getLogger(__name__)

router = APIRouter(prefix="/candidates", tags=["candidates"])


@router.post("/check-duplicate", response_model=DuplicateCheckResult)
def check_duplicate(
    payload: DuplicateCheckRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(CANDIDATES_CREATE, CANDIDATES_READ, CANDIDATES_READ_OWN))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> DuplicateCheckResult:
    """Check whether a candidate with the given email/phone already exists.

    Called client-side before creating a new candidate to surface potential
    duplicates and give the recruiter a chance to abort or open the existing record.
    """
    if not payload.email and not payload.phone:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Provide at least one of email or phone.",
        )
    org_id = UUID(current_user.organization_id)
    svc = DuplicateDetectionService()
    result = svc.check(
        email=payload.email,
        phone=payload.phone,
        org_id=org_id,
        db=db,
        exclude_id=payload.exclude_id,
    )
    return DuplicateCheckResult(
        has_duplicates=result.has_duplicates,
        matches=[
            DuplicateMatchOut(
                candidate_id=m.candidate_id,
                first_name=m.first_name,
                last_name=m.last_name,
                email=m.email,
                phone=m.phone,
                location=m.location,
                pipeline_count=m.pipeline_count,
                confidence=m.confidence,
                match_type=m.match_type,
            )
            for m in result.matches
        ],
    )


@router.post("", response_model=CandidateResponse, status_code=status.HTTP_201_CREATED)
def create_candidate(
    payload: CandidateCreate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_CREATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> CandidateResponse:
    service = CandidateService(db)
    candidate = service.create_candidate(UUID(current_user.organization_id), payload, current_user=current_user)
    return CandidateResponse.model_validate(candidate)


@router.get("", response_model=list[CandidateResponse])
def list_candidates(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(CANDIDATES_READ, CANDIDATES_READ_OWN))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[CandidateResponse]:
    service = CandidateService(db)
    candidates = service.list_candidates(
        UUID(current_user.organization_id),
        current_user,
        limit=limit,
        offset=offset,
    )
    return [CandidateResponse.model_validate(candidate) for candidate in candidates]


@router.get("/{candidate_id}", response_model=CandidateResponse)
def get_candidate(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(CANDIDATES_READ, CANDIDATES_READ_OWN))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> CandidateResponse:
    service = CandidateService(db)
    candidate = service.get_candidate_by_id(
        candidate_id,
        UUID(current_user.organization_id),
        current_user,
        include_archived=True,
    )
    return CandidateResponse.model_validate(candidate)


@router.put("/{candidate_id}", response_model=CandidateResponse)
def update_candidate(
    candidate_id: UUID,
    payload: CandidateUpdate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> CandidateResponse:
    service = CandidateService(db)
    candidate = service.update_candidate(
        candidate_id=candidate_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
        payload=payload,
    )
    return CandidateResponse.model_validate(candidate)


@router.get("/{candidate_id}/placements", response_model=CandidatePlacementListResponse)
def list_candidate_placements(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(CANDIDATES_READ, CANDIDATES_READ_OWN))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> CandidatePlacementListResponse:
    """AIR-503: Read-only placement history from candidate_placement_history (latest per job, newest first)."""
    org_id = UUID(current_user.organization_id)
    CandidateService(db).get_candidate_by_id(
        candidate_id, org_id, current_user, include_archived=True
    )
    return PlacementHistoryService(db).list_for_candidate(
        candidate_id=candidate_id,
        organization_id=org_id,
    )


@router.get("/{candidate_id}/matches", response_model=CandidateMatchesResponse)
def get_candidate_matches(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(CANDIDATES_READ, CANDIDATES_READ_OWN, ATS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> CandidateMatchesResponse:
    service = JobService(db)
    return service.get_candidate_matches(
        candidate_id=candidate_id,
        organization_id=UUID(current_user.organization_id),
        current_user=current_user,
        limit=limit,
        offset=offset,
    )


@router.post("/{candidate_id}/merge", response_model=MergeResponse)
def merge_candidates(
    candidate_id: UUID,
    payload: MergeRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_MERGE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> MergeResponse:
    """Merge a duplicate candidate into the survivor (admin-only).

    ``candidate_id`` is the **survivor** — the record to keep.
    ``payload.duplicate_id`` is the record that will be soft-deleted after
    all its pipeline/interview/ATS history is reassigned to the survivor.
    """
    org_id = UUID(current_user.organization_id)
    actor_id = UUID(current_user.user_id)
    svc = CandidateMergeService()
    try:
        svc.merge(
            survivor_id=candidate_id,
            duplicate_id=payload.duplicate_id,
            actor_id=actor_id,
            org_id=org_id,
            db=db,
        )
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.error("cand006.merge.unexpected_error", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "MERGE_FAILED",
                "message": str(exc) or "An unexpected error occurred during merge.",
            },
        ) from exc
    return MergeResponse(
        survivor_id=str(candidate_id),
        duplicate_id=str(payload.duplicate_id),
        message="Candidates merged successfully.",
    )


@router.post("/{candidate_id}/rescore", response_model=AtsCandidateRescoreResponse)
def rescore_candidate_matches(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(CANDIDATES_UPDATE, ATS_RESCORE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    sync: Annotated[
        bool,
        Query(description="Run full deterministic+semantic pipeline in-request (slow; for debugging)."),
    ] = False,
    job_id: Annotated[
        UUID | None,
        Query(description="Scope rescore to a single candidate-job pair. Omit to rescore all pipeline jobs."),
    ] = None,
) -> AtsCandidateRescoreResponse:
    org_id = UUID(current_user.organization_id)
    service = JobService(db)
    if sync:
        try:
            pairs = service.rescore_candidate_full_sync(
                organization_id=org_id, candidate_id=candidate_id, job_id=job_id
            )
            db.commit()
        except Exception as exc:
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={
                    "error": "ATS_RESCORE_FAILED",
                    "message": str(exc).strip() or repr(exc),
                    "exception_type": type(exc).__name__,
                },
            ) from exc
        return AtsCandidateRescoreResponse(
            status="completed",
            candidate_id=candidate_id,
            pairs_scored=pairs,
            semantic_enrichment="inline_full" if JobService.semantic_provider_configured() else "disabled",
            mode="full_sync",
        )
    try:
        pairs = service.rescore_candidate_fast(
            organization_id=org_id, candidate_id=candidate_id, job_id=job_id
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "ATS_RESCORE_FAILED",
                "message": str(exc).strip() or repr(exc),
                "exception_type": type(exc).__name__,
            },
        ) from exc
    if pairs > 0 and JobService.semantic_provider_configured():
        sem = "queued"
    elif not JobService.semantic_provider_configured():
        sem = "disabled"
    else:
        sem = "none"
    return AtsCandidateRescoreResponse(
        status="completed",
        candidate_id=candidate_id,
        pairs_scored=pairs,
        semantic_enrichment=sem,
        mode="fast",
    )


@router.post("/{candidate_id}/archive", status_code=status.HTTP_200_OK)
def archive_candidate(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_DELETE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> dict[str, object]:
    """AIR-510: Archive (soft-delete) — sets is_deleted and deleted_at; row retained."""
    org_id = UUID(current_user.organization_id)
    CandidateService(db).archive_candidate(candidate_id, org_id, current_user)
    return {"archived": True, "candidate_id": str(candidate_id)}


@router.delete("/{candidate_id}", status_code=status.HTTP_200_OK)
def delete_candidate(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_DELETE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> dict[str, object]:
    """Permanent hard delete — removes candidate data."""
    org_id = UUID(current_user.organization_id)
    CandidateService(db).hard_delete_candidate(candidate_id, org_id, current_user)
    return {"deleted": True, "hard_deleted": True, "candidate_id": str(candidate_id)}


@router.patch("/{candidate_id}/restore", response_model=CandidateResponse)
def restore_candidate(
    candidate_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CANDIDATES_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> CandidateResponse:
    """AIR-512: Admin restore — sets is_deleted=false."""
    org_id = UUID(current_user.organization_id)
    candidate = CandidateService(db).restore_candidate(candidate_id, org_id, current_user)
    return CandidateResponse.model_validate(candidate)

