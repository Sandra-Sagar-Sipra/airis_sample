"""PIPE-007: Pipeline Analytics Service.

All aggregations run as single SQL statements — no N+1, no in-memory joins.
Data sources: `pipeline_stage_history` + `pipelines` tables (no new tables needed).

Security: every query carries `organization_id` so cross-tenant leakage is impossible.
Vendor/client scoping is enforced via `AccessScopeService.allowed_job_ids_subquery`.
"""
from __future__ import annotations

import logging
from datetime import UTC, date, datetime
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy import func, literal_column, select, text
from sqlalchemy.orm import Session

from app.models.pipeline import Pipeline, PipelineStageHistory
from app.schemas.auth import CurrentUser
from app.schemas.pipeline_analytics import (
    DropOffEntry,
    PipelineAnalyticsResponse,
    StageDurationEntry,
    StageFunnelEntry,
)
from app.services.access_scope_service import AccessScopeService

logger = logging.getLogger(__name__)

# Canonical forward-progression funnel stages (terminal stages excluded from funnel steps).
FUNNEL_STAGES: list[str] = [
    "applied",
    "ai_interview",
    "interview",
    "offer",
    "placed",
]

STAGE_LABELS: dict[str, str] = {
    "applied": "Applied",
    "ai_interview": "AI Interview",
    "interview": "Interview",
    "offer": "Offer",
    "placed": "Placed",
    "rejected": "Rejected",
}

# "Next" stage for each forward stage (used for conversion rate computation).
NEXT_STAGE: dict[str, str] = {
    "applied": "ai_interview",
    "ai_interview": "interview",
    "interview": "offer",
    "offer": "placed",
}


class PipelineAnalyticsService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self._scope = AccessScopeService(db)

    # ── Public API ─────────────────────────────────────────────────────────────

    def get_analytics(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
        *,
        job_id: UUID | None = None,
        start_date: date | None = None,
        end_date: date | None = None,
    ) -> PipelineAnalyticsResponse:
        """
        Compute full pipeline analytics.  All queries are DB-level aggregations.

        Steps:
        1. Build org-scope + access-scope pipeline subquery (job access filter for
           client/vendor users).
        2. Run transition matrix query against pipeline_stage_history.
        3. Run current-stage distribution query against pipelines.
        4. Run stage-duration CTE query using LEAD window function.
        5. Combine results in Python (arithmetic only — no DB round-trips for this).
        """
        # ── 1. Scoped pipeline ID subquery ─────────────────────────────────────
        scoped_pipeline_ids = self._scoped_pipeline_ids_subquery(
            organization_id,
            current_user,
            job_id=job_id,
            start_date=start_date,
            end_date=end_date,
        )

        # ── 2. Transition matrix: {(prev_stage, new_stage): count} ────────────
        transition_matrix = self._transition_matrix(
            organization_id,
            scoped_pipeline_ids,
            start_date=start_date,
            end_date=end_date,
        )

        # ── 3. Current stage distribution ──────────────────────────────────────
        current_distribution = self._current_stage_distribution(scoped_pipeline_ids)

        # ── 4. Stage durations ──────────────────────────────────────────────────
        stage_durations_raw = self._stage_duration_stats(
            organization_id,
            scoped_pipeline_ids,
            start_date=start_date,
            end_date=end_date,
        )

        # ── 5. Total pipeline count ────────────────────────────────────────────
        # Derived from current_distribution so no extra DB round-trip is needed.
        total_pipelines = sum(current_distribution.values())

        # ── 6. Assemble response ────────────────────────────────────────────────
        return self._build_response(
            organization_id=organization_id,
            job_id=job_id,
            start_date=start_date,
            end_date=end_date,
            total_pipelines=total_pipelines,
            transition_matrix=transition_matrix,
            current_distribution=current_distribution,
            stage_durations_raw=stage_durations_raw,
        )

    def get_analytics_csv_rows(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
        *,
        job_id: UUID | None = None,
        start_date: date | None = None,
        end_date: date | None = None,
    ) -> list[dict]:
        """Return flat rows suitable for CSV export."""
        analytics = self.get_analytics(
            organization_id,
            current_user,
            job_id=job_id,
            start_date=start_date,
            end_date=end_date,
        )
        rows: list[dict] = []

        # Funnel rows
        for entry in analytics.funnel:
            rows.append(
                {
                    "section": "Conversion Funnel",
                    "stage": entry.label,
                    "entered": entry.entered,
                    "advanced": entry.advanced,
                    "rejected": entry.rejected,
                    "still_in_stage": entry.still_in_stage,
                    "conversion_rate_pct": f"{entry.conversion_rate:.1f}",
                    "rejection_rate_pct": f"{entry.rejection_rate:.1f}",
                    "avg_days_in_stage": "",
                    "median_days_in_stage": "",
                    "sample_count": "",
                    "drop_off_rank": "",
                    "is_bottleneck": "",
                }
            )

        # Duration rows (merge into funnel rows by stage name where possible)
        duration_by_stage = {d.stage: d for d in analytics.stage_durations}
        for entry in analytics.funnel:
            dur = duration_by_stage.get(entry.stage)
            if dur:
                # Find and update the matching row
                for row in rows:
                    if row["stage"] == entry.label and row["section"] == "Conversion Funnel":
                        row["avg_days_in_stage"] = f"{dur.avg_days:.1f}"
                        row["median_days_in_stage"] = (
                            f"{dur.median_days:.1f}" if dur.median_days is not None else ""
                        )
                        row["sample_count"] = str(dur.sample_count)
                        break

        # Drop-off rows
        for entry in analytics.drop_off:
            rows.append(
                {
                    "section": "Drop-Off Analysis",
                    "stage": entry.label,
                    "entered": "",
                    "advanced": "",
                    "rejected": entry.rejected_count,
                    "still_in_stage": "",
                    "conversion_rate_pct": "",
                    "rejection_rate_pct": f"{entry.drop_off_rate:.1f}",
                    "avg_days_in_stage": "",
                    "median_days_in_stage": "",
                    "sample_count": "",
                    "drop_off_rank": entry.rank,
                    "is_bottleneck": "Yes" if entry.is_bottleneck else "No",
                }
            )

        # Summary row
        rows.append(
            {
                "section": "Summary",
                "stage": "Total",
                "entered": analytics.total_pipelines,
                "advanced": analytics.total_placed,
                "rejected": analytics.total_rejected,
                "still_in_stage": "",
                "conversion_rate_pct": f"{analytics.overall_placement_rate:.1f}",
                "rejection_rate_pct": "",
                "avg_days_in_stage": "",
                "median_days_in_stage": "",
                "sample_count": "",
                "drop_off_rank": "",
                "is_bottleneck": "",
            }
        )

        return rows

    # ── Private query helpers ──────────────────────────────────────────────────

    def _scoped_pipeline_ids_subquery(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
        *,
        job_id: UUID | None = None,
        start_date: date | None = None,
        end_date: date | None = None,
    ):
        """Return a subquery of Pipeline.id matching all scope + filters."""
        stmt = select(Pipeline.id).where(Pipeline.organization_id == organization_id)

        if job_id is not None:
            stmt = stmt.where(Pipeline.job_id == job_id)

        # Date-range filter on pipeline creation date (inclusive on both ends).
        if start_date is not None:
            stmt = stmt.where(Pipeline.created_at >= start_date)
        if end_date is not None:
            # Extend to end of day.
            stmt = stmt.where(Pipeline.created_at < sa.func.date_trunc(
                "day", sa.cast(end_date, sa.Date)
            ) + text("interval '1 day'"))

        # Vendor / client users can only see jobs they have access to.
        if self._scope.is_scoped_user(current_user):
            stmt = stmt.where(
                Pipeline.job_id.in_(self._scope.allowed_job_ids_subquery(current_user))
            )

        return stmt.subquery()

    def _transition_matrix(
        self,
        organization_id: UUID,
        pipeline_ids_subquery,
        *,
        start_date: date | None = None,
        end_date: date | None = None,
    ) -> dict[tuple[str, str], int]:
        """
        Return {(previous_stage, new_stage): count_distinct_pipelines}.

        Scoped to the provided pipeline IDs subquery.
        History's transitioned_at is also filtered by date range when supplied.
        """
        stmt = (
            select(
                PipelineStageHistory.previous_stage,
                PipelineStageHistory.new_stage,
                func.count(PipelineStageHistory.pipeline_id.distinct()).label("cnt"),
            )
            .where(
                PipelineStageHistory.organization_id == organization_id,
                PipelineStageHistory.pipeline_id.in_(
                    select(pipeline_ids_subquery.c.id)
                ),
            )
        )

        if start_date is not None:
            stmt = stmt.where(PipelineStageHistory.transitioned_at >= start_date)
        if end_date is not None:
            stmt = stmt.where(
                PipelineStageHistory.transitioned_at < sa.func.date_trunc(
                    "day", sa.cast(end_date, sa.Date)
                ) + text("interval '1 day'")
            )

        stmt = stmt.group_by(
            PipelineStageHistory.previous_stage, PipelineStageHistory.new_stage
        )

        result: dict[tuple[str, str], int] = {}
        for row in self.db.execute(stmt):
            if row.previous_stage is not None:
                result[(row.previous_stage, row.new_stage)] = row.cnt
        return result

    def _current_stage_distribution(self, pipeline_ids_subquery) -> dict[str, int]:
        """Return {stage: count} for all pipelines currently in each stage."""
        stmt = (
            select(Pipeline.stage, func.count().label("cnt"))
            .where(Pipeline.id.in_(select(pipeline_ids_subquery.c.id)))
            .group_by(Pipeline.stage)
        )
        return {row.stage: row.cnt for row in self.db.execute(stmt)}

    def _stage_duration_stats(
        self,
        organization_id: UUID,
        pipeline_ids_subquery,
        *,
        start_date: date | None = None,
        end_date: date | None = None,
    ) -> list[tuple[str, float, float | None, int]]:
        """
        Return [(stage, avg_days, median_days, sample_count)] using a LEAD window
        function over pipeline_stage_history.

        Only COMPLETED transitions are included (next transition exists),
        giving true stage-to-stage durations rather than inflated open-ended values.
        """
        # CTE: annotate each history row with the timestamp of the NEXT transition
        # for the same pipeline (NULL if still in that stage).
        history_cte = (
            select(
                PipelineStageHistory.pipeline_id,
                PipelineStageHistory.new_stage.label("stage"),
                PipelineStageHistory.transitioned_at,
                func.lead(PipelineStageHistory.transitioned_at)
                .over(
                    partition_by=PipelineStageHistory.pipeline_id,
                    order_by=PipelineStageHistory.transitioned_at,
                )
                .label("next_at"),
            )
            .where(
                PipelineStageHistory.organization_id == organization_id,
                PipelineStageHistory.pipeline_id.in_(
                    select(pipeline_ids_subquery.c.id)
                ),
            )
        ).cte("history_with_lead")

        if start_date is not None:
            history_cte = (
                select(
                    PipelineStageHistory.pipeline_id,
                    PipelineStageHistory.new_stage.label("stage"),
                    PipelineStageHistory.transitioned_at,
                    func.lead(PipelineStageHistory.transitioned_at)
                    .over(
                        partition_by=PipelineStageHistory.pipeline_id,
                        order_by=PipelineStageHistory.transitioned_at,
                    )
                    .label("next_at"),
                )
                .where(
                    PipelineStageHistory.organization_id == organization_id,
                    PipelineStageHistory.pipeline_id.in_(
                        select(pipeline_ids_subquery.c.id)
                    ),
                    PipelineStageHistory.transitioned_at >= start_date,
                )
            ).cte("history_with_lead")

        # Aggregate: avg + percentile (median) per stage on COMPLETED transitions only.
        days_expr = (
            sa.extract("epoch", history_cte.c.next_at - history_cte.c.transitioned_at)
            / 86400.0
        )

        agg_stmt = (
            select(
                history_cte.c.stage,
                func.avg(days_expr).label("avg_days"),
                func.percentile_cont(0.5)
                .within_group(days_expr.asc())
                .label("median_days"),
                func.count().label("sample_count"),
            )
            .where(history_cte.c.next_at.is_not(None))  # completed transitions only
            .group_by(history_cte.c.stage)
        )

        return [
            (row.stage, float(row.avg_days or 0), float(row.median_days) if row.median_days is not None else None, row.sample_count)
            for row in self.db.execute(agg_stmt)
        ]

    # ── Response builder ───────────────────────────────────────────────────────

    def _build_response(
        self,
        *,
        organization_id: UUID,
        job_id: UUID | None,
        start_date: date | None,
        end_date: date | None,
        total_pipelines: int,
        transition_matrix: dict[tuple[str, str], int],
        current_distribution: dict[str, int],
        stage_durations_raw: list[tuple[str, float, float | None, int]],
    ) -> PipelineAnalyticsResponse:
        # ── Funnel ─────────────────────────────────────────────────────────────
        # For each stage in FUNNEL_STAGES, compute entered / advanced / rejected.
        # We iterate in reverse to perfectly handle skipped stages and guarantee a 
        # monotonically decreasing cumulative funnel.
        
        funnel_entries_by_stage = {}
        next_entered = 0

        for stage in reversed(FUNNEL_STAGES):
            still_in_stage = current_distribution.get(stage, 0)
            exited_rejected = transition_matrix.get((stage, "rejected"), 0)
            
            # Everyone who entered the NEXT stage MUST have passed through this stage
            exited_forward = next_entered
            
            entered = still_in_stage + exited_forward + exited_rejected
            
            conversion_rate = (exited_forward / entered * 100) if entered > 0 else 0.0
            rejection_rate = (exited_rejected / entered * 100) if entered > 0 else 0.0
            
            funnel_entries_by_stage[stage] = StageFunnelEntry(
                stage=stage,
                label=STAGE_LABELS.get(stage, stage.replace("_", " ").title()),
                entered=entered,
                advanced=exited_forward,
                rejected=exited_rejected,
                still_in_stage=still_in_stage,
                conversion_rate=round(conversion_rate, 1),
                rejection_rate=round(rejection_rate, 1),
            )
            
            next_entered = entered

        # Re-order back to forward chronological order
        funnel = [funnel_entries_by_stage[s] for s in FUNNEL_STAGES]

        # ── Stage durations ─────────────────────────────────────────────────────
        if stage_durations_raw:
            avg_of_avgs = sum(r[1] for r in stage_durations_raw) / len(stage_durations_raw)
        else:
            avg_of_avgs = 0.0

        stage_durations: list[StageDurationEntry] = [
            StageDurationEntry(
                stage=stage,
                label=STAGE_LABELS.get(stage, stage.replace("_", " ").title()),
                avg_days=round(avg_days, 1),
                median_days=round(median_days, 1) if median_days is not None else None,
                sample_count=sample_count,
                is_slow=avg_days > avg_of_avgs * 1.25,  # 25% above overall mean
            )
            for stage, avg_days, median_days, sample_count in stage_durations_raw
        ]

        # ── Drop-off analysis ──────────────────────────────────────────────────
        # Compute rejection counts and rates per stage.
        drop_off_entries: list[tuple[str, int, float]] = []
        for stage in FUNNEL_STAGES[:-1]:  # exclude "placed"
            rejected_count = transition_matrix.get((stage, "rejected"), 0)
            if rejected_count == 0:
                continue
            entered = next(
                (f.entered for f in funnel if f.stage == stage), 0
            )
            rate = (rejected_count / entered * 100) if entered > 0 else 0.0
            drop_off_entries.append((stage, rejected_count, rate))

        # Sort by rate descending.
        drop_off_entries.sort(key=lambda x: x[2], reverse=True)
        max_rate = drop_off_entries[0][2] if drop_off_entries else 0.0

        drop_off: list[DropOffEntry] = [
            DropOffEntry(
                stage=stage,
                label=STAGE_LABELS.get(stage, stage.replace("_", " ").title()),
                rejected_count=count,
                drop_off_rate=round(rate, 1),
                is_bottleneck=(rate == max_rate and rate > 0),
                rank=rank + 1,
            )
            for rank, (stage, count, rate) in enumerate(drop_off_entries)
        ]

        # ── Summary stats ──────────────────────────────────────────────────────
        total_placed = current_distribution.get("placed", 0)
        total_rejected = current_distribution.get("rejected", 0)
        denom = total_placed + total_rejected
        placement_rate = (total_placed / denom * 100) if denom > 0 else 0.0

        return PipelineAnalyticsResponse(
            organization_id=organization_id,
            job_id=job_id,
            date_range_start=start_date,
            date_range_end=end_date,
            total_pipelines=total_pipelines,
            total_placed=total_placed,
            total_rejected=total_rejected,
            overall_placement_rate=round(placement_rate, 1),
            funnel=funnel,
            stage_durations=stage_durations,
            drop_off=drop_off,
            generated_at=datetime.now(UTC),
        )
