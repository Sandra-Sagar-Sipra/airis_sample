from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import Select, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.candidate import Candidate
from app.models.pipeline import Pipeline, PipelineStageHistory, PipelineStatusHistory
from app.models.job import Job
from app.core.config import get_settings
from app.schemas.auth import CurrentUser
from app.schemas.pipeline import (
    PipelineCreate,
    PipelineSortBy,
    PipelineSortDir,
    PipelineStage,
    PipelineStageTransitionRequest,
    PipelineStatus,
    PipelineStatusChangeRequest,
    PipelineUpdate,
    WithdrawPipelineRequest,
)
from app.services.access_scope_service import AccessScopeService
from app.services.candidate_service import CandidateService

logger = logging.getLogger(__name__)

# ── PIPE-002: Valid stage transitions ─────────────────────────────────────────
# Terminal stages (placed, rejected) have no outgoing transitions.
VALID_TRANSITIONS: dict[str, frozenset[str]] = {
    PipelineStage.APPLIED.value:      frozenset({PipelineStage.AI_INTERVIEW.value, PipelineStage.REJECTED.value}),
    PipelineStage.AI_INTERVIEW.value: frozenset({PipelineStage.INTERVIEW.value, PipelineStage.REJECTED.value}),
    PipelineStage.INTERVIEW.value:    frozenset({PipelineStage.OFFER.value, PipelineStage.REJECTED.value}),
    PipelineStage.OFFER.value:        frozenset({PipelineStage.PLACED.value, PipelineStage.REJECTED.value}),
    PipelineStage.PLACED.value:       frozenset(),
    PipelineStage.REJECTED.value:     frozenset(),
}


class PipelineService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self._scope = AccessScopeService(db)
        self._candidates = CandidateService(db)

    def create_pipeline(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: PipelineCreate,
        *,
        commit: bool = True,
    ) -> Pipeline:
        self._candidates.get_candidate_by_id(payload.candidate_id, organization_id, current_user)

        # Validate job exists (and scope it for client users) without instantiating JobService
        # to avoid circular construction between JobService <-> PipelineService.
        stmt = select(Job).where(Job.id == payload.job_id, Job.organization_id == organization_id)
        if self._scope.is_client_user(current_user):
            # Filter by allowed job IDs via SQL subquery (no Python list materialization).
            stmt = stmt.where(Job.id.in_(self._scope.allowed_job_ids_subquery(current_user)))

        job = self.db.scalar(stmt)
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")

        existing = self.db.scalar(
            select(Pipeline.id).where(
                Pipeline.organization_id == organization_id,
                Pipeline.candidate_id == payload.candidate_id,
                Pipeline.job_id == payload.job_id,
            )
        )
        if existing is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A pipeline already exists for this candidate and job.",
            )

        pipeline = Pipeline(
            organization_id=organization_id,
            candidate_id=payload.candidate_id,
            job_id=payload.job_id,
            stage=payload.stage.value,
            status=payload.status.value,
            notes=payload.notes,
        )
        self.db.add(pipeline)
        try:
            # Flush instead of committing so callers can atomically create
            # JobSubmission + Pipeline in a single transaction.
            self.db.flush()
        except IntegrityError:
            self.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A pipeline already exists for this candidate and job.",
            ) from None
        if commit:
            self.db.commit()
        self.db.refresh(pipeline)
        return pipeline

    def _build_pipeline_filter_stmt(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
        *,
        job_id: UUID | None = None,
        candidate_id: UUID | None = None,
        client_id: UUID | None = None,
        stage: PipelineStage | None = None,
        pipeline_status: PipelineStatus | None = None,
    ) -> Select:
        """Return a base SELECT statement with all org-scope and filter predicates applied.

        client_id filter: joins to the jobs table and filters by jobs.client_id.
        This is additive with job_id (both can be specified simultaneously).
        """
        stmt: Select = select(Pipeline).where(Pipeline.organization_id == organization_id)
        if job_id is not None:
            stmt = stmt.where(Pipeline.job_id == job_id)
        if candidate_id is not None:
            stmt = stmt.where(Pipeline.candidate_id == candidate_id)
        if client_id is not None:
            # Join to jobs to filter by client_id — no explicit FK on Pipeline.
            stmt = stmt.join(Job, Job.id == Pipeline.job_id).where(Job.client_id == client_id)
        if stage is not None:
            stmt = stmt.where(Pipeline.stage == stage.value)
        if pipeline_status is not None:
            stmt = stmt.where(Pipeline.status == pipeline_status.value)
        if self._scope.is_scoped_user(current_user):
            stmt = stmt.where(Pipeline.job_id.in_(self._scope.allowed_job_ids_subquery(current_user)))
        return stmt

    def list_pipelines(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
        *,
        limit: int = 50,
        offset: int = 0,
        job_id: UUID | None = None,
        candidate_id: UUID | None = None,
        client_id: UUID | None = None,
        stage: PipelineStage | None = None,
        pipeline_status: PipelineStatus | None = None,
        sort_by: PipelineSortBy = PipelineSortBy.CREATED_AT,
        sort_dir: PipelineSortDir = PipelineSortDir.DESC,
    ) -> list[Pipeline]:
        stmt = self._build_pipeline_filter_stmt(
            organization_id,
            current_user,
            job_id=job_id,
            candidate_id=candidate_id,
            client_id=client_id,
            stage=stage,
            pipeline_status=pipeline_status,
        )
        order_col = Pipeline.stage_updated_at if sort_by == PipelineSortBy.STAGE_UPDATED_AT else Pipeline.created_at
        stmt = stmt.order_by(order_col.asc() if sort_dir == PipelineSortDir.ASC else order_col.desc())
        stmt = stmt.offset(offset).limit(limit)
        pipelines = list(self.db.scalars(stmt))
        logger.info(
            "Pipeline list fetched",
            extra={
                "organization_id": str(organization_id),
                "job_id": str(job_id) if job_id else None,
                "candidate_id": str(candidate_id) if candidate_id else None,
                "count": len(pipelines),
            },
        )
        return pipelines

    def list_pipelines_paginated(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
        *,
        limit: int = 50,
        offset: int = 0,
        job_id: UUID | None = None,
        candidate_id: UUID | None = None,
        client_id: UUID | None = None,
        stage: PipelineStage | None = None,
        pipeline_status: PipelineStatus | None = None,
        sort_by: PipelineSortBy = PipelineSortBy.CREATED_AT,
        sort_dir: PipelineSortDir = PipelineSortDir.DESC,
    ) -> tuple[list[Pipeline], int, dict[str, int]]:
        """PIPE-004: Return (pipelines, total_count, stage_counts).

        - ``total_count`` is the full count matching all filters (before pagination).
        - ``stage_counts`` is a per-stage breakdown across ALL filters EXCEPT the
          stage filter itself, giving callers visibility into the full distribution.
        - ``client_id`` filters pipelines whose linked job belongs to that client.
        """
        # ── 1. Filtered page ──────────────────────────────────────────────────
        paginated_stmt = self._build_pipeline_filter_stmt(
            organization_id,
            current_user,
            job_id=job_id,
            candidate_id=candidate_id,
            client_id=client_id,
            stage=stage,
            pipeline_status=pipeline_status,
        )
        order_col = Pipeline.stage_updated_at if sort_by == PipelineSortBy.STAGE_UPDATED_AT else Pipeline.created_at
        paginated_stmt = paginated_stmt.order_by(
            order_col.asc() if sort_dir == PipelineSortDir.ASC else order_col.desc()
        ).offset(offset).limit(limit)
        pipelines = list(self.db.scalars(paginated_stmt))

        # ── 2. Total count (same filters, no pagination) ──────────────────────
        count_stmt = self._build_pipeline_filter_stmt(
            organization_id,
            current_user,
            job_id=job_id,
            candidate_id=candidate_id,
            client_id=client_id,
            stage=stage,
            pipeline_status=pipeline_status,
        )
        total: int = self.db.scalar(
            select(func.count()).select_from(count_stmt.subquery())
        ) or 0

        # ── 3. Stage counts (all filters EXCEPT stage for full facet view) ────
        stage_count_base = self._build_pipeline_filter_stmt(
            organization_id,
            current_user,
            job_id=job_id,
            candidate_id=candidate_id,
            client_id=client_id,
            stage=None,            # intentionally omit stage filter
            pipeline_status=pipeline_status,
        )
        # Use the subquery's own columns — referencing Pipeline.stage / Pipeline.id
        # directly after .select_from(subquery) creates a cross-join in SQLAlchemy.
        sub = stage_count_base.subquery()
        stage_count_stmt = (
            select(sub.c.stage, func.count(sub.c.id).label("cnt"))
            .group_by(sub.c.stage)
        )
        stage_counts: dict[str, int] = {
            row.stage: row.cnt for row in self.db.execute(stage_count_stmt)
        }

        logger.info(
            "Pipeline paginated list fetched",
            extra={
                "organization_id": str(organization_id),
                "total": total,
                "returned": len(pipelines),
                "stage_counts": stage_counts,
            },
        )
        return pipelines, total, stage_counts

    def list_pipeline_candidates_for_job(
        self,
        job_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        *,
        limit: int = 200,
        offset: int = 0,
    ) -> list[tuple[UUID, Candidate]]:
        """
        Pipelines for a single job with candidate rows (one round-trip in SQL).
        Enforces the same org + access-scope rules as list_pipelines + candidate visibility.
        """
        stmt: Select[tuple[UUID, Candidate]] = (
            select(Pipeline.id, Candidate)
            .join(Candidate, Candidate.id == Pipeline.candidate_id)
            .where(
                Pipeline.organization_id == organization_id,
                Pipeline.job_id == job_id,
                Candidate.is_deleted.is_(False),
            )
        )
        if self._scope.is_scoped_user(current_user):
            stmt = stmt.where(Pipeline.job_id.in_(self._scope.allowed_job_ids_subquery(current_user)))
        if self._scope.is_vendor_user(current_user):
            stmt = stmt.where(Candidate.created_by == UUID(current_user.user_id))

        stmt = stmt.order_by(Pipeline.created_at.desc()).offset(offset).limit(limit)
        rows = self.db.execute(stmt).all()
        return [(row[0], row[1]) for row in rows]

    def get_pipeline_by_id(self, pipeline_id: UUID, organization_id: UUID, current_user: CurrentUser | None = None) -> Pipeline:
        logger.info(
            "Pipeline lookup requested",
            extra={"pipeline_id": str(pipeline_id), "organization_id": str(organization_id)},
        )
        stmt: Select[tuple[Pipeline]] = select(Pipeline).where(
            Pipeline.id == pipeline_id,
            Pipeline.organization_id == organization_id,
        )
        if current_user is not None and self._scope.is_scoped_user(current_user):
            stmt = stmt.where(Pipeline.job_id.in_(self._scope.allowed_job_ids_subquery(current_user)))
        pipeline = self.db.scalar(stmt)
        if pipeline is None:
            other_org_pipeline = self.db.scalar(select(Pipeline.organization_id).where(Pipeline.id == pipeline_id))
            mismatch = other_org_pipeline is not None
            logger.warning(
                "Pipeline lookup failed",
                extra={
                    "pipeline_id": str(pipeline_id),
                    "organization_id": str(organization_id),
                    "exists_other_org": mismatch,
                    "owner_organization_id": str(other_org_pipeline) if other_org_pipeline else None,
                },
            )
            settings = get_settings()
            if settings.debug:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail={
                        "error": "Pipeline not found",
                        "hint": "Pipeline may belong to another organization or token mismatch",
                        "pipeline_id": str(pipeline_id),
                        "organization_id": str(organization_id),
                    },
                )
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Pipeline not found.",
            )
        return pipeline

    def update_pipeline(
        self,
        pipeline_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: PipelineUpdate,
    ) -> Pipeline:
        pipeline = self.get_pipeline_by_id(pipeline_id, organization_id, current_user)

        update_data = payload.model_dump(exclude_unset=True)
        if "stage" in update_data and update_data["stage"] is not None:
            update_data["stage"] = update_data["stage"].value
        if "status" in update_data and update_data["status"] is not None:
            update_data["status"] = update_data["status"].value

        for field, value in update_data.items():
            setattr(pipeline, field, value)

        self.db.add(pipeline)
        self.db.commit()
        self.db.refresh(pipeline)
        return pipeline

    # Backward-compatible alias for existing callers.
    def update_pipeline_stage(
        self,
        pipeline_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: PipelineUpdate,
    ) -> Pipeline:
        return self.update_pipeline(pipeline_id, organization_id, current_user, payload)

    def list_all_pipelines_debug(self, *, limit: int = 200, offset: int = 0) -> list[Pipeline]:
        stmt: Select[tuple[Pipeline]] = (
            select(Pipeline).order_by(Pipeline.created_at.desc()).offset(offset).limit(limit)
        )
        return list(self.db.scalars(stmt))

    # ── PIPE-002: Controlled stage transition ─────────────────────────────────

    def transition_stage(
        self,
        pipeline_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: PipelineStageTransitionRequest,
    ) -> Pipeline:
        """
        Validate and apply a stage transition.

        Raises:
            422 — if the requested transition is not valid from the current stage.
            422 — if rejecting without a sufficient reason (enforced by Pydantic schema).
            404 — if the pipeline is not found.
        """
        pipeline = self.get_pipeline_by_id(pipeline_id, organization_id, current_user)

        current_stage = pipeline.stage
        new_stage = payload.stage.value
        allowed_targets = VALID_TRANSITIONS.get(current_stage, frozenset())

        if new_stage not in allowed_targets:
            allowed_display = ", ".join(sorted(allowed_targets)) if allowed_targets else "none (terminal stage)"
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"Cannot transition from '{current_stage}' to '{new_stage}'. "
                    f"Allowed transitions: {allowed_display}."
                ),
            )

        # Record history before mutating the pipeline row.
        history = PipelineStageHistory(
            pipeline_id=pipeline.id,
            organization_id=organization_id,
            previous_stage=current_stage,
            new_stage=new_stage,
            actor_user_id=UUID(current_user.user_id) if current_user.user_id else None,
            reason=payload.reason,
            transitioned_at=datetime.now(UTC),
        )
        self.db.add(history)
        self.db.flush()
        stage_history_id = history.id

        from app.services.placement_history_service import PlacementHistoryService

        PlacementHistoryService(self.db).record_pipeline_stage(
            candidate_id=pipeline.candidate_id,
            job_id=pipeline.job_id,
            stage=new_stage,
            transitioned_at=history.transitioned_at,
        )

        # Apply stage change; auto-close terminal stages.
        # PIPE-004: record when the stage was last updated for sort-by-stage-updated.
        pipeline.stage = new_stage
        pipeline.stage_updated_at = datetime.now(UTC)
        if new_stage in (PipelineStage.PLACED.value, PipelineStage.REJECTED.value):
            pipeline.status = PipelineStatus.CLOSED.value

        self.db.add(pipeline)
        self.db.commit()
        self.db.refresh(pipeline)

        # COMM-005: best-effort notification — commit already happened so this
        # must NEVER raise; any exception is swallowed and logged.
        try:
            _notify_stage_change(
                db=self.db,
                pipeline=pipeline,
                organization_id=organization_id,
                previous_stage=current_stage,
                new_stage=new_stage,
                actor_user_id=UUID(current_user.user_id) if current_user.user_id else None,
                reason=payload.reason,
                stage_history_id=stage_history_id,
            )
        except Exception:
            logger.warning(
                "pipeline.notify_stage_change.failed pipeline_id=%s — suppressed",
                pipeline_id,
                exc_info=True,
            )

        logger.info(
            "pipeline.stage_transition pipeline_id=%s %s→%s actor=%s",
            pipeline_id,
            current_stage,
            new_stage,
            current_user.user_id,
        )

        # ── AI Interview: auto-create when candidate enters AI interview stage ──
        if new_stage == PipelineStage.AI_INTERVIEW.value:
            try:
                from app.services.ai_screening_service import AIScreeningService
                AIScreeningService(self.db).auto_create_for_pipeline(
                    org_id=organization_id,
                    candidate_id=pipeline.candidate_id,
                    job_id=pipeline.job_id,
                    pipeline_id=pipeline.id,
                    created_by=UUID(current_user.user_id) if current_user.user_id else None,
                )
            except Exception:
                logger.warning(
                    "pipeline.ai_interview_auto_create.failed pipeline_id=%s — suppressed",
                    pipeline_id,
                    exc_info=True,
                )

        return pipeline

    def get_stage_history(
        self,
        pipeline_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> list[PipelineStageHistory]:
        """Return the full ordered stage-transition history for a pipeline."""
        # Access check — raises 404 if not found / not accessible.
        self.get_pipeline_by_id(pipeline_id, organization_id, current_user)

        return list(
            self.db.scalars(
                select(PipelineStageHistory)
                .where(
                    PipelineStageHistory.pipeline_id == pipeline_id,
                    PipelineStageHistory.organization_id == organization_id,
                )
                .order_by(PipelineStageHistory.transitioned_at)
            ).all()
        )

    # ── PIPE-003: Status tracking ─────────────────────────────────────────────

    def change_pipeline_status(
        self,
        pipeline_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: PipelineStatusChangeRequest,
    ) -> Pipeline:
        """
        PIPE-003: Apply a deliberate status change with full audit trail.

        Raises:
            409  — if the requested status equals the current status (no-op).
            403  — if a non-admin attempts to reopen a closed/placed pipeline.
        """
        pipeline = self.get_pipeline_by_id(pipeline_id, organization_id, current_user)

        current_status = pipeline.status
        new_status = payload.status.value

        if current_status == new_status:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Pipeline status is already '{current_status}'.",
            )

        # Prevent re-opening a closed pipeline unless the caller is an admin.
        if current_status == PipelineStatus.CLOSED.value and not _is_admin(current_user):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only administrators can reopen a closed pipeline.",
            )

        now = datetime.now(UTC)
        history = PipelineStatusHistory(
            pipeline_id=pipeline.id,
            organization_id=organization_id,
            previous_status=current_status,
            new_status=new_status,
            actor_user_id=UUID(current_user.user_id) if current_user.user_id else None,
            reason=payload.reason,
            changed_at=now,
        )
        self.db.add(history)

        pipeline.status = new_status
        pipeline.status_changed_at = now
        self.db.add(pipeline)
        self.db.commit()
        self.db.refresh(pipeline)

        # COMM-005: best-effort notification — commit already happened.
        try:
            _notify_status_change(
                db=self.db,
                pipeline=pipeline,
                previous_status=current_status,
                new_status=new_status,
                actor_user_id=UUID(current_user.user_id) if current_user.user_id else None,
                reason=payload.reason,
            )
        except Exception:
            logger.warning(
                "pipeline.notify_status_change.failed pipeline_id=%s — suppressed",
                pipeline_id,
                exc_info=True,
            )

        logger.info(
            "pipeline.status_change pipeline_id=%s %s→%s actor=%s",
            pipeline_id,
            current_status,
            new_status,
            current_user.user_id,
        )
        return pipeline

    def withdraw_pipeline(
        self,
        pipeline_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: WithdrawPipelineRequest,
    ) -> Pipeline:
        """
        PIPE-003: Withdraw a pipeline (candidate-requested removal).

        Delegates to change_pipeline_status with status=WITHDRAWN.
        Exposed as a dedicated endpoint so callers don't need to know
        the internal PipelineStatus enum.
        """
        return self.change_pipeline_status(
            pipeline_id,
            organization_id,
            current_user,
            PipelineStatusChangeRequest(
                status=PipelineStatus.WITHDRAWN,
                reason=payload.reason,
            ),
        )

    def get_status_history(
        self,
        pipeline_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> list[PipelineStatusHistory]:
        """Return the full ordered status-change history for a pipeline (PIPE-003)."""
        self.get_pipeline_by_id(pipeline_id, organization_id, current_user)

        return list(
            self.db.scalars(
                select(PipelineStatusHistory)
                .where(
                    PipelineStatusHistory.pipeline_id == pipeline_id,
                    PipelineStatusHistory.organization_id == organization_id,
                )
                .order_by(PipelineStatusHistory.changed_at)
            ).all()
        )


# ── Internal helpers ──────────────────────────────────────────────────────────

def _is_admin(current_user: CurrentUser) -> bool:
    return (getattr(current_user, "role", "") or "").lower() == "admin"


# ── COMM-005 helpers ───────────────────────────────────────────────────────────

def _notify_stage_change(
    *,
    db: Session,
    pipeline: Pipeline,
    organization_id: UUID,
    previous_stage: str,
    new_stage: str,
    actor_user_id: UUID | None,
    reason: str | None,
    stage_history_id: UUID,
) -> None:
    """
    COMM-005: Fire a best-effort notification on stage change.

    Records a timeline interaction synchronously, then dispatches automated
    candidate email delivery on a background thread (AIR-570/572).
    """
    from app.candidate_management.models import CandidateInteraction, InteractionType  # noqa: PLC0415
    from app.candidate_management.models import Candidate as CMCandidate  # noqa: PLC0415
    from app.services.pipeline_stage_notification_service import (  # noqa: PLC0415
        run_pipeline_stage_email_notification,
    )
    from app.services.task_runner import dispatch_task  # noqa: PLC0415
    from sqlalchemy import select as _select  # noqa: PLC0415

    cm_candidate = db.scalar(
        _select(CMCandidate).where(CMCandidate.id == pipeline.candidate_id)
    )
    if cm_candidate is None:
        return

    note = f"Stage changed: {previous_stage} → {new_stage}"
    if reason:
        note += f"\nReason: {reason}"

    stage_metadata: dict[str, str | None] = {
        "pipeline_id": str(pipeline.id),
        "job_id": str(pipeline.job_id) if pipeline.job_id else None,
        "previous_stage": previous_stage,
        "new_stage": new_stage,
        "stage_history_id": str(stage_history_id),
    }

    try:
        interaction = CandidateInteraction(
            org_id=cm_candidate.org_id,
            workspace_id=cm_candidate.workspace_id,
            candidate_id=cm_candidate.id,
            interaction_type=InteractionType.STAGE_CHANGE,
            title=f"Pipeline stage: {new_stage}",
            body=note,
            interaction_metadata=stage_metadata,
            actor_user_id=actor_user_id,
        )
        db.add(interaction)
        db.commit()
    except Exception:
        logger.warning(
            "comm_005.notify_stage_change failed pipeline_id=%s — suppressed",
            pipeline.id,
            exc_info=True,
        )
        try:
            db.rollback()
        except Exception:
            pass

    if actor_user_id is None:
        return

    try:
        dispatch_task(
            task=None,
            fallback=run_pipeline_stage_email_notification,
            kwargs={
                "organization_id": str(organization_id),
                "org_id": str(cm_candidate.org_id),
                "workspace_id": str(cm_candidate.workspace_id),
                "candidate_id": str(cm_candidate.id),
                "pipeline_id": str(pipeline.id),
                "job_id": str(pipeline.job_id) if pipeline.job_id else None,
                "previous_stage": previous_stage,
                "new_stage": new_stage,
                "stage_history_id": str(stage_history_id),
                "actor_user_id": str(actor_user_id),
                "reason": reason,
            },
        )
    except Exception:
        logger.warning(
            "pipeline_stage_email.dispatch_failed pipeline_id=%s — suppressed",
            pipeline.id,
            exc_info=True,
        )


def _notify_status_change(
    *,
    db: Session,
    pipeline: Pipeline,
    previous_status: str,
    new_status: str,
    actor_user_id: UUID | None,
    reason: str | None,
) -> None:
    """
    COMM-005: Fire a best-effort notification on pipeline status change (PIPE-003).

    Records a CandidateInteraction for the status event. Email / push delivery
    can be wired in here once COMM templates are defined for status events.
    """
    try:
        from app.candidate_management.models import CandidateInteraction, InteractionType  # noqa: PLC0415
        from app.candidate_management.models import Candidate as CMCandidate  # noqa: PLC0415
        from sqlalchemy import select as _select  # noqa: PLC0415

        cm_candidate = db.scalar(
            _select(CMCandidate).where(CMCandidate.id == pipeline.candidate_id)
        )
        if cm_candidate is None:
            return

        note = f"Status changed: {previous_status} → {new_status}"
        if reason:
            note += f"\nReason: {reason}"

        interaction = CandidateInteraction(
            org_id=cm_candidate.org_id,
            workspace_id=cm_candidate.workspace_id,
            candidate_id=cm_candidate.id,
            interaction_type=InteractionType.STAGE_CHANGE,
            title=f"Pipeline status: {new_status}",
            body=note,
            actor_user_id=actor_user_id,
        )
        db.add(interaction)
        db.commit()
    except Exception:
        logger.warning(
            "comm_005.notify_status_change failed pipeline_id=%s — suppressed",
            pipeline.id,
            exc_info=True,
        )
