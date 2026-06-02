from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.candidate_placement_history import (
    PLACEMENT_OUTCOMES,
    TRACKED_PIPELINE_STAGE_OUTCOMES,
    CandidatePlacementHistory,
)
from app.models.job import Job
from app.models.pipeline import Pipeline, PipelineStageHistory
from app.schemas.placement_history import CandidatePlacementListResponse, CandidatePlacementResponse, PlacementOutcome

logger = logging.getLogger(__name__)


_OUTCOME_ALIASES: dict[str, str] = {
    # Legacy stage name kept in pipeline enums; DB constraint now uses ai_screening.
    "ai_interview": "ai_screening",
}


def _normalize_outcome(value: str | None) -> str:
    normalized = (value or "").strip().lower()
    return _OUTCOME_ALIASES.get(normalized, normalized)


class PlacementHistoryService:
    """
    Append-only placement history (AIR-37 / AIR-504).

    Public write API: append_record, record_pending_submission, record_pipeline_stage, record_terminal_stage.
    Public read API: list_for_candidate.
    No update or delete methods — ORM listeners also block mutation on the model.
    """

    # AIR-504: explicit allow-list for static analysis and tests.
    _MUTATION_METHOD_NAMES = frozenset({"update_record", "delete_record", "patch_record"})

    def __init__(self, db: Session) -> None:
        self.db = db

    @classmethod
    def public_method_names(cls) -> frozenset[str]:
        return frozenset(
            name
            for name in dir(cls)
            if not name.startswith("_")
            and callable(getattr(cls, name))
            and name not in {"public_method_names"}
        )

    def append_record(
        self,
        *,
        candidate_id: UUID,
        job_id: UUID,
        outcome: str,
        placement_date: datetime | None = None,
    ) -> CandidatePlacementHistory:
        normalized = _normalize_outcome(outcome)
        if normalized not in PLACEMENT_OUTCOMES:
            raise ValueError(f"Invalid placement outcome: {outcome}")
        when = placement_date or datetime.now(UTC)
        row = CandidatePlacementHistory(
            candidate_id=candidate_id,
            job_id=job_id,
            outcome=normalized,
            placement_date=when,
        )
        self.db.add(row)
        return row

    def record_pending_submission(
        self,
        *,
        candidate_id: UUID,
        job_id: UUID,
        submitted_at: datetime | None = None,
    ) -> CandidatePlacementHistory:
        return self.append_record(
            candidate_id=candidate_id,
            job_id=job_id,
            outcome=PlacementOutcome.PENDING.value,
            placement_date=submitted_at,
        )

    def _latest_outcome_for_job(
        self,
        *,
        candidate_id: UUID,
        job_id: UUID,
    ) -> str | None:
        stmt = (
            select(CandidatePlacementHistory.outcome)
            .where(
                CandidatePlacementHistory.candidate_id == candidate_id,
                CandidatePlacementHistory.job_id == job_id,
            )
            .order_by(
                CandidatePlacementHistory.placement_date.desc(),
                CandidatePlacementHistory.created_at.desc(),
            )
            .limit(1)
        )
        return self.db.scalar(stmt)

    def record_pipeline_stage(
        self,
        *,
        candidate_id: UUID,
        job_id: UUID,
        stage: str,
        transitioned_at: datetime | None = None,
    ) -> CandidatePlacementHistory | None:
        """Append a pipeline stage row; skips duplicate consecutive outcomes for same job."""
        normalized = _normalize_outcome(stage)
        if normalized not in TRACKED_PIPELINE_STAGE_OUTCOMES:
            return None
        if self._latest_outcome_for_job(candidate_id=candidate_id, job_id=job_id) == normalized:
            return None
        return self.append_record(
            candidate_id=candidate_id,
            job_id=job_id,
            outcome=normalized,
            placement_date=transitioned_at,
        )

    def record_terminal_stage(
        self,
        *,
        candidate_id: UUID,
        job_id: UUID,
        stage: str,
        transitioned_at: datetime | None = None,
    ) -> CandidatePlacementHistory | None:
        """Backward-compatible alias — placed/rejected use same append path as other stages."""
        return self.record_pipeline_stage(
            candidate_id=candidate_id,
            job_id=job_id,
            stage=stage,
            transitioned_at=transitioned_at,
        )

    def _rejection_reasons_by_job(
        self,
        *,
        candidate_id: UUID,
        organization_id: UUID,
        job_ids: list[UUID],
    ) -> dict[UUID, str]:
        """Latest rejection note per job from immutable pipeline_stage_history."""
        if not job_ids:
            return {}
        stmt = (
            select(Pipeline.job_id, PipelineStageHistory.reason)
            .join(Pipeline, PipelineStageHistory.pipeline_id == Pipeline.id)
            .where(
                Pipeline.candidate_id == candidate_id,
                Pipeline.organization_id == organization_id,
                Pipeline.job_id.in_(job_ids),
                PipelineStageHistory.new_stage == PlacementOutcome.REJECTED.value,
                PipelineStageHistory.reason.is_not(None),
            )
            .order_by(PipelineStageHistory.transitioned_at.desc())
        )
        reasons: dict[UUID, str] = {}
        for job_id, reason in self.db.execute(stmt).all():
            if job_id in reasons or not reason:
                continue
            text = str(reason).strip()
            if text:
                reasons[job_id] = text
        return reasons

    def _enrich_from_active_pipelines(
        self,
        *,
        candidate_id: UUID,
        organization_id: UUID,
        items: list[CandidatePlacementResponse],
    ) -> list[CandidatePlacementResponse]:
        """Show current pipeline stage per job when no placement row exists yet (legacy pipelines)."""
        jobs_with_rows = {item.job_id for item in items}
        stmt = (
            select(Pipeline, Job.title)
            .join(Job, Job.id == Pipeline.job_id)
            .where(
                Pipeline.candidate_id == candidate_id,
                Pipeline.organization_id == organization_id,
                Job.organization_id == organization_id,
            )
        )
        for pipeline, job_title in self.db.execute(stmt).all():
            if pipeline.job_id in jobs_with_rows:
                continue
            normalized = _normalize_outcome(pipeline.stage)
            if normalized not in PLACEMENT_OUTCOMES:
                continue
            try:
                outcome = PlacementOutcome(normalized)
            except ValueError:
                continue
            when = pipeline.stage_updated_at or pipeline.updated_at or pipeline.created_at
            items.append(
                CandidatePlacementResponse(
                    id=pipeline.id,
                    candidate_id=candidate_id,
                    job_id=pipeline.job_id,
                    job_title=job_title or "Unknown Job",
                    outcome=outcome,
                    placement_date=when,
                    created_at=pipeline.created_at,
                )
            )
            jobs_with_rows.add(pipeline.job_id)
        return items

    def _enrich_from_stage_history(
        self,
        *,
        candidate_id: UUID,
        organization_id: UUID,
        items: list[CandidatePlacementResponse],
    ) -> list[CandidatePlacementResponse]:
        """Backfill display rows from immutable pipeline_stage_history when placement rows are missing."""
        seen: set[tuple[UUID, str]] = {(item.job_id, item.outcome.value) for item in items}
        stmt = (
            select(PipelineStageHistory, Pipeline.job_id, Job.title)
            .join(Pipeline, PipelineStageHistory.pipeline_id == Pipeline.id)
            .join(Job, Job.id == Pipeline.job_id)
            .where(
                Pipeline.candidate_id == candidate_id,
                Pipeline.organization_id == organization_id,
                Job.organization_id == organization_id,
            )
            .order_by(PipelineStageHistory.transitioned_at.desc())
        )
        for history_row, job_id, job_title in self.db.execute(stmt).all():
            normalized = _normalize_outcome(history_row.new_stage)
            if normalized not in PLACEMENT_OUTCOMES:
                continue
            key = (job_id, normalized)
            if key in seen:
                continue
            seen.add(key)
            try:
                outcome = PlacementOutcome(normalized)
            except ValueError:
                continue
            items.append(
                CandidatePlacementResponse(
                    id=history_row.id,
                    candidate_id=candidate_id,
                    job_id=job_id,
                    job_title=job_title or "Unknown Job",
                    outcome=outcome,
                    placement_date=history_row.transitioned_at,
                    created_at=history_row.transitioned_at,
                )
            )
        return items

    def list_for_candidate(
        self,
        *,
        candidate_id: UUID,
        organization_id: UUID,
    ) -> CandidatePlacementListResponse:
        """
        AIR-503: Full chronological timeline (newest first); every append-only stage row is returned.

        Joins jobs for title and scopes rows to the caller's organization.
        """
        stmt = (
            select(CandidatePlacementHistory, Job.title)
            .join(Job, Job.id == CandidatePlacementHistory.job_id)
            .where(
                CandidatePlacementHistory.candidate_id == candidate_id,
                Job.organization_id == organization_id,
            )
            .order_by(
                CandidatePlacementHistory.placement_date.desc(),
                CandidatePlacementHistory.created_at.desc(),
            )
        )
        rows = self.db.execute(stmt).all()

        items: list[CandidatePlacementResponse] = []
        for history_row, job_title in rows:
            try:
                outcome = PlacementOutcome(_normalize_outcome(history_row.outcome))
            except ValueError:
                logger.warning(
                    "placement_history.skipped_unknown_outcome",
                    extra={"outcome": history_row.outcome, "row_id": str(history_row.id)},
                )
                continue
            items.append(
                CandidatePlacementResponse(
                    id=history_row.id,
                    candidate_id=history_row.candidate_id,
                    job_id=history_row.job_id,
                    job_title=job_title or "Unknown Job",
                    outcome=outcome,
                    placement_date=history_row.placement_date,
                    created_at=history_row.created_at,
                )
            )

        rejected_job_ids = list({item.job_id for item in items if item.outcome == PlacementOutcome.REJECTED})
        rejection_reasons = self._rejection_reasons_by_job(
            candidate_id=candidate_id,
            organization_id=organization_id,
            job_ids=rejected_job_ids,
        )
        if rejection_reasons:
            items = [
                item.model_copy(
                    update={
                        "rejection_reason": rejection_reasons.get(item.job_id),
                    }
                )
                if item.outcome == PlacementOutcome.REJECTED
                else item
                for item in items
            ]

        items = self._enrich_from_stage_history(
            candidate_id=candidate_id,
            organization_id=organization_id,
            items=items,
        )
        items = self._enrich_from_active_pipelines(
            candidate_id=candidate_id,
            organization_id=organization_id,
            items=items,
        )
        items.sort(
            key=lambda row: (row.placement_date, row.created_at),
            reverse=True,
        )

        return CandidatePlacementListResponse(data=items, total=len(items))
