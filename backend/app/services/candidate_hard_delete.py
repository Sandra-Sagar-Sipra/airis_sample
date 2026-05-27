"""Purge all candidate-scoped rows on permanent delete (GDPR / fresh re-create)."""
from __future__ import annotations

import logging
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.candidate_management.models import BulkUploadItem, Candidate
from app.models.ai_screening import AIScreening
from app.models.application import Application
from app.models.candidate_job_match import CandidateJobMatch
from app.models.candidate_placement_history import CandidatePlacementHistory
from app.models.interview import Interview
from app.models.job_submission import JobSubmission
from app.models.pipeline import Pipeline
from app.models.offer import PipelineOffer

logger = logging.getLogger(__name__)


def _safe_execute(db: Session, stmt) -> None:
    try:
        with db.begin_nested():
            db.execute(stmt)
    except sa.exc.ProgrammingError as exc:
        logger.warning("candidate_hard_delete skip (missing table?): %s", exc)
    except Exception as exc:  # noqa: BLE001
        logger.warning("candidate_hard_delete skip: %s", exc)


def collect_candidate_job_ids(db: Session, *, candidate_id: UUID, organization_id: UUID) -> set[UUID]:
    job_ids: set[UUID] = set()
    for stmt in (
        select(Pipeline.job_id).where(
            Pipeline.candidate_id == candidate_id,
            Pipeline.organization_id == organization_id,
        ),
        select(JobSubmission.job_id).where(JobSubmission.candidate_id == candidate_id),
        select(CandidateJobMatch.job_id).where(
            CandidateJobMatch.candidate_id == candidate_id,
            CandidateJobMatch.organization_id == organization_id,
        ),
        select(AIScreening.job_id).where(
            AIScreening.candidate_id == candidate_id,
            AIScreening.organization_id == organization_id,
            AIScreening.job_id.is_not(None),
        ),
    ):
        try:
            job_ids.update(db.scalars(stmt).all())
        except Exception as exc:  # noqa: BLE001
            logger.warning("collect_candidate_job_ids: %s", exc)
    return {jid for jid in job_ids if jid is not None}


def purge_candidate_dependents(
    db: Session,
    *,
    candidate_id: UUID,
    organization_id: UUID,
) -> set[UUID]:
    """
    Delete pipelines, ATS matches, screenings, interviews, submissions, etc.
    Returns job_ids that need match-cache refresh.
    """
    job_ids = collect_candidate_job_ids(db, candidate_id=candidate_id, organization_id=organization_id)

    pipeline_ids = list(
        db.scalars(
            select(Pipeline.id).where(
                Pipeline.candidate_id == candidate_id,
                Pipeline.organization_id == organization_id,
            )
        )
    )

    if pipeline_ids:
        _safe_execute(db, delete(Interview).where(Interview.pipeline_id.in_(pipeline_ids)))
        _safe_execute(db, delete(PipelineOffer).where(PipelineOffer.pipeline_id.in_(pipeline_ids)))

    _safe_execute(
        db,
        delete(Interview).where(
            Interview.candidate_id == candidate_id,
            Interview.organization_id == organization_id,
        ),
    )
    _safe_execute(
        db,
        delete(Pipeline).where(
            Pipeline.candidate_id == candidate_id,
            Pipeline.organization_id == organization_id,
        ),
    )
    _safe_execute(
        db,
        delete(CandidateJobMatch).where(
            CandidateJobMatch.candidate_id == candidate_id,
            CandidateJobMatch.organization_id == organization_id,
        ),
    )
    _safe_execute(db, delete(JobSubmission).where(JobSubmission.candidate_id == candidate_id))
    _safe_execute(db, delete(Application).where(Application.candidate_id == candidate_id))
    _safe_execute(
        db,
        delete(AIScreening).where(
            AIScreening.candidate_id == candidate_id,
            AIScreening.organization_id == organization_id,
        ),
    )
    # Bulk ORM delete bypasses placement_history before_delete listener.
    _safe_execute(db, delete(CandidatePlacementHistory).where(CandidatePlacementHistory.candidate_id == candidate_id))

    try:
        with db.begin_nested():
            db.execute(
                sa.update(BulkUploadItem)
                .where(BulkUploadItem.candidate_id == candidate_id)
                .values(candidate_id=None)
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("candidate_hard_delete bulk_upload: %s", exc)

    return job_ids


def delete_candidate_row(
    db: Session,
    *,
    org_id: UUID,
    workspace_id: UUID,
    candidate_id: UUID,
) -> int:
    """SQL DELETE candidate; cascades skills, interactions, audit logs."""
    result = db.execute(
        delete(Candidate).where(
            Candidate.id == candidate_id,
            Candidate.org_id == org_id,
            Candidate.workspace_id == workspace_id,
        ).execution_options(synchronize_session=False)
    )
    return int(result.rowcount or 0)


def refresh_job_match_caches(db: Session, *, organization_id: UUID, job_ids: set[UUID]) -> None:
    if not job_ids:
        return
    from app.services.job_service import JobService

    service = JobService(db)
    for job_id in job_ids:
        try:
            service._refresh_job_match_cache(job_id=job_id, organization_id=organization_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("refresh_job_match_cache job=%s: %s", job_id, exc)
    try:
        db.flush()
    except Exception:
        pass
