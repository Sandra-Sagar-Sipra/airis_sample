"""Dashboard summary endpoint.

Returns all data the dashboard needs in a single round-trip:
  - KPI counts + 7-day trends
  - Pipeline stage counts
  - 5 most-recent jobs with per-job candidate counts
  - 20 most-recent activity items (pipeline moves + new jobs)

All aggregation is done in Postgres — the browser never downloads raw
candidate/job/pipeline arrays just to count them.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user, require_any_permissions
from app.core.permissions import CANDIDATES_READ, CANDIDATES_READ_OWN, JOBS_READ, PIPELINE_READ
from app.db.session import get_db
from app.models.candidate import Candidate
from app.models.job import Job
from app.models.pipeline import Pipeline
from app.schemas.auth import CurrentUser
from app.services.access_scope_service import AccessScopeService
from app.services.permission_service import PermissionService

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


# ── Response schemas ──────────────────────────────────────────────────────────

class PipelineStages(BaseModel):
    sourced: int = 0
    ai_interview: int = 0
    interview: int = 0
    offer: int = 0
    placed: int = 0


class RecentJob(BaseModel):
    id: UUID
    title: str
    status: str
    location: str | None = None
    employment_type: str | None = None
    created_at: datetime
    candidate_count: int = 0


class ActivityItem(BaseModel):
    id: str
    type: str  # 'candidate_stage' | 'job_created' | 'placement'
    title: str
    subtitle: str
    timestamp: datetime


class DashboardSummary(BaseModel):
    # KPI cards
    total_candidates: int = 0
    candidates_trend: int = 0
    active_jobs: int = 0
    jobs_trend: int = 0
    in_pipeline: int = 0
    pipeline_trend: int = 0
    placements: int = 0
    placements_trend: int = 0
    # Funnel
    pipeline_stages: PipelineStages = PipelineStages()
    # Tables / feeds
    recent_jobs: list[RecentJob] = []
    activities: list[ActivityItem] = []


# ── Helpers ───────────────────────────────────────────────────────────────────

def _trend(recent: int, previous: int) -> int:
    """Percentage change from previous → recent period."""
    if previous == 0:
        return 100 if recent > 0 else 0
    return round(((recent - previous) / previous) * 100)


def _candidate_belongs_to_org(org_id: UUID):
    """Match legacy (organization_id) and candidate-management (org_id) rows."""
    return or_(
        Candidate.organization_id == org_id,
        Candidate.org_id == org_id,
    )


def _candidate_is_active():
    """Active under legacy is_deleted or candidate-management deleted_at."""
    return and_(
        Candidate.is_deleted.is_(False),
        Candidate.deleted_at.is_(None),
    )


def _candidate_where_clauses(
    org_id: UUID,
    *,
    scope: AccessScopeService,
    current_user: CurrentUser,
) -> list:
    clauses = [_candidate_belongs_to_org(org_id), _candidate_is_active()]
    if scope.is_client_user(current_user):
        clauses.append(
            Candidate.id.in_(
                select(Pipeline.candidate_id).where(
                    Pipeline.job_id.in_(scope.allowed_job_ids_subquery(current_user))
                )
            )
        )
    elif scope.is_vendor_user(current_user):
        clauses.append(Candidate.created_by == UUID(current_user.user_id))
    return clauses


def _pipeline_where_clauses(
    org_id: UUID,
    *,
    scope: AccessScopeService,
    current_user: CurrentUser,
) -> list:
    clauses = [Pipeline.organization_id == org_id]
    if scope.is_scoped_user(current_user):
        clauses.append(Pipeline.job_id.in_(scope.allowed_job_ids_subquery(current_user)))
    return clauses


def _job_where_clauses(
    org_id: UUID,
    *,
    scope: AccessScopeService,
    current_user: CurrentUser,
) -> list:
    clauses = [Job.organization_id == org_id]
    if scope.is_scoped_user(current_user):
        clauses.append(Job.id.in_(scope.allowed_job_ids_subquery(current_user)))
    return clauses


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/summary", response_model=DashboardSummary)
def get_dashboard_summary(
    db: Annotated[Session, Depends(get_db)],
    # Require at least one of these permissions — any role that can see the
    # dashboard will have at least one.
    _: Annotated[CurrentUser, Depends(
        require_any_permissions(JOBS_READ, CANDIDATES_READ, CANDIDATES_READ_OWN, PIPELINE_READ)
    )],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> DashboardSummary:
    org_id = UUID(current_user.organization_id)
    scope = AccessScopeService(db)

    def _tz(dt: datetime | None) -> datetime:
        """Return dt as UTC-aware; treats naive datetimes as UTC (legacy rows)."""
        if dt is None:
            return datetime.now(UTC)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=UTC)
        return dt

    now = datetime.now(UTC)
    t7 = now - timedelta(days=7)
    t14 = now - timedelta(days=14)

    # Fetch all permissions in one query rather than per-check round trips.
    perms = set(PermissionService(db).get_user_permissions(current_user.user_id))

    can_candidates = bool(perms & {"candidates:read", "candidates:read_own"})
    can_jobs = "jobs:read" in perms
    can_pipeline = "pipeline:read" in perms

    # ── Candidates ────────────────────────────────────────────────────────────
    total_candidates = 0
    candidates_trend = 0

    if can_candidates:
        cand_where = _candidate_where_clauses(org_id, scope=scope, current_user=current_user)
        cand_counts = db.execute(
            select(
                func.count(Candidate.id).label("total"),
                func.count(Candidate.id)
                .filter(Candidate.created_at >= t7)
                .label("recent"),
                func.count(Candidate.id)
                .filter(and_(Candidate.created_at >= t14, Candidate.created_at < t7))
                .label("previous"),
            ).where(*cand_where)
        ).one()
        total_candidates = int(cand_counts.total or 0)
        candidates_trend = _trend(int(cand_counts.recent or 0), int(cand_counts.previous or 0))

    # ── Jobs ──────────────────────────────────────────────────────────────────
    active_jobs = 0
    jobs_trend = 0
    recent_jobs: list[RecentJob] = []

    if can_jobs:
        job_where = _job_where_clauses(org_id, scope=scope, current_user=current_user)

        active_jobs = db.scalar(
            select(func.count(Job.id)).where(*job_where, Job.status == "open")
        ) or 0

        job_trends = db.execute(
            select(
                func.count(Job.id).filter(Job.created_at >= t7).label("recent"),
                func.count(Job.id)
                .filter(and_(Job.created_at >= t14, Job.created_at < t7))
                .label("previous"),
            ).where(*job_where)
        ).one()
        jobs_trend = _trend(int(job_trends.recent or 0), int(job_trends.previous or 0))

        # Recent jobs table: 5 most recent, with candidate count per job
        job_rows = db.execute(
            select(Job)
            .where(*job_where)
            .order_by(Job.created_at.desc())
            .limit(5)
        ).scalars().all()

        if job_rows:
            job_ids = [j.id for j in job_rows]
            # Candidate counts per job from pipelines
            cand_counts_rows = db.execute(
                select(
                    Pipeline.job_id,
                    func.count(Pipeline.id).label("cnt"),
                )
                .where(
                    Pipeline.organization_id == org_id,
                    Pipeline.job_id.in_(job_ids),
                )
                .group_by(Pipeline.job_id)
            ).all()
            cand_counts = {row.job_id: row.cnt for row in cand_counts_rows}

            recent_jobs = [
                RecentJob(
                    id=j.id,
                    title=j.title,
                    status=j.status or "open",
                    location=j.location,
                    employment_type=j.employment_type,
                    created_at=_tz(j.created_at),
                    candidate_count=cand_counts.get(j.id, 0),
                )
                for j in job_rows
            ]

    # ── Pipeline ──────────────────────────────────────────────────────────────
    in_pipeline = 0
    pipeline_trend = 0
    placements = 0
    placements_trend = 0
    pipeline_stages = PipelineStages()
    activities: list[ActivityItem] = []

    if can_pipeline:
        pipe_where = _pipeline_where_clauses(org_id, scope=scope, current_user=current_user)

        # Stage counts (single aggregation query)
        stage_rows = db.execute(
            select(
                Pipeline.stage,
                Pipeline.status,
                func.count(Pipeline.id).label("cnt"),
            )
            .where(*pipe_where)
            .group_by(Pipeline.stage, Pipeline.status)
        ).all()

        stage_map: dict[tuple[str, str], int] = {
            (r.stage, r.status): r.cnt for r in stage_rows
        }

        def _active(stage: str) -> int:
            return stage_map.get((stage, "active"), 0)

        pipeline_stages = PipelineStages(
            sourced=_active("applied"),
            ai_interview=_active("ai_interview"),
            interview=_active("interview"),
            offer=_active("offer"),
            placed=sum(v for (s, _), v in stage_map.items() if s == "placed"),
        )
        placements = pipeline_stages.placed

        in_pipeline = sum(
            v for (s, st), v in stage_map.items()
            if st == "active" and s not in ("placed", "rejected")
        )

        pipe_trends = db.execute(
            select(
                func.count(Pipeline.id)
                .filter(Pipeline.created_at >= t7)
                .label("recent_pipe"),
                func.count(Pipeline.id)
                .filter(and_(Pipeline.created_at >= t14, Pipeline.created_at < t7))
                .label("prev_pipe"),
                func.count(Pipeline.id)
                .filter(and_(Pipeline.stage == "placed", Pipeline.updated_at >= t7))
                .label("recent_placed"),
                func.count(Pipeline.id)
                .filter(
                    and_(
                        Pipeline.stage == "placed",
                        Pipeline.updated_at >= t14,
                        Pipeline.updated_at < t7,
                    )
                )
                .label("prev_placed"),
            ).where(*pipe_where)
        ).one()
        pipeline_trend = _trend(int(pipe_trends.recent_pipe or 0), int(pipe_trends.prev_pipe or 0))
        placements_trend = _trend(int(pipe_trends.recent_placed or 0), int(pipe_trends.prev_placed or 0))

        # Activity feed: 20 most recent pipeline moves, enriched with names
        activity_rows = db.execute(
            select(
                Pipeline.id,
                Pipeline.stage,
                Pipeline.updated_at,
                Candidate.first_name,
                Candidate.last_name,
                Job.title.label("job_title"),
            )
            .join(Candidate, Candidate.id == Pipeline.candidate_id)
            .join(Job, Job.id == Pipeline.job_id)
            .where(*pipe_where)
            .order_by(Pipeline.updated_at.desc())
            .limit(15)
        ).all()

        for row in activity_rows:
            act_type = "placement" if row.stage == "placed" else "candidate_stage"
            stage_label = row.stage.replace("_", " ").title()
            activities.append(
                ActivityItem(
                    id=f"p-{row.id}",
                    type=act_type,
                    title=f"{row.first_name} {row.last_name} → {stage_label}",
                    subtitle=row.job_title,
                    timestamp=_tz(row.updated_at),
                )
            )

    # Mix in recent job-created events
    if can_jobs and recent_jobs:
        for job in recent_jobs:
            activities.append(
                ActivityItem(
                    id=f"j-{job.id}",
                    type="job_created",
                    title="New job created",
                    subtitle=job.title,
                    timestamp=_tz(job.created_at),
                )
            )
        activities.sort(key=lambda a: _tz(a.timestamp), reverse=True)
        activities = activities[:20]

    return DashboardSummary(
        total_candidates=total_candidates,
        candidates_trend=candidates_trend,
        active_jobs=active_jobs,
        jobs_trend=jobs_trend,
        in_pipeline=in_pipeline,
        pipeline_trend=pipeline_trend,
        placements=placements,
        placements_trend=placements_trend,
        pipeline_stages=pipeline_stages,
        recent_jobs=recent_jobs,
        activities=activities,
    )
