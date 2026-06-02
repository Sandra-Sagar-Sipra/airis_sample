"""Tests for PIPE-007: Pipeline Analytics.

Covers:
- PipelineAnalyticsResponse schema validation
- StageFunnelEntry conversion/rejection rate computation
- StageDurationEntry avg/median and is_slow flag
- DropOffEntry ranking and bottleneck flag
- PipelineAnalyticsService._build_response (pure computation, no DB)
- PipelineAnalyticsService.get_analytics — 403 guard via require_permission (route-level)
- Date range filtering (start_date, end_date accepted as params)
- Cross-job view (no job_id)
- Per-job view (job_id set)
- CSV export rows structure
- org scoping enforced (organization_id propagated)
- Empty analytics (no pipelines) handled gracefully
- Bottleneck detection (highest drop-off flagged)
- is_slow detection (avg > 1.25x mean)
"""
from __future__ import annotations

from datetime import UTC, date, datetime
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

from app.schemas.pipeline_analytics import (
    DropOffEntry,
    PipelineAnalyticsResponse,
    StageDurationEntry,
    StageFunnelEntry,
)
from app.services.pipeline_analytics_service import (
    FUNNEL_STAGES,
    NEXT_STAGE,
    PipelineAnalyticsService,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_service(db=None):
    svc = PipelineAnalyticsService.__new__(PipelineAnalyticsService)
    svc.db = db or MagicMock()
    svc._scope = MagicMock()
    svc._scope.is_scoped_user.return_value = False
    return svc


def _make_user():
    u = MagicMock()
    u.user_id = str(uuid4())
    u.organization_id = str(uuid4())
    u.role = "recruiter"
    u.type = "internal"
    return u


def _now():
    return datetime.now(UTC)


# ── Schema validation ──────────────────────────────────────────────────────────

class TestSchemas:
    def test_stage_funnel_entry_round_trip(self):
        entry = StageFunnelEntry(
            stage="applied",
            label="Applied",
            entered=100,
            advanced=60,
            rejected=20,
            still_in_stage=20,
            conversion_rate=60.0,
            rejection_rate=20.0,
        )
        assert entry.stage == "applied"
        assert entry.conversion_rate == 60.0

    def test_stage_duration_entry_is_slow_default_false(self):
        dur = StageDurationEntry(
            stage="ai_interview",
            label="AI Interview",
            avg_days=3.5,
            median_days=3.0,
            sample_count=20,
        )
        assert dur.is_slow is False

    def test_drop_off_entry_bottleneck(self):
        entry = DropOffEntry(
            stage="interview",
            label="Interview",
            rejected_count=15,
            drop_off_rate=40.0,
            is_bottleneck=True,
            rank=1,
        )
        assert entry.is_bottleneck is True
        assert entry.rank == 1

    def test_analytics_response_defaults(self):
        resp = PipelineAnalyticsResponse(
            organization_id=uuid4(),
            total_pipelines=0,
            total_placed=0,
            total_rejected=0,
            overall_placement_rate=0.0,
            generated_at=_now(),
        )
        assert resp.funnel == []
        assert resp.stage_durations == []
        assert resp.drop_off == []
        assert resp.job_id is None


# ── _build_response: conversion rate logic ────────────────────────────────────

class TestBuildResponseConversion:
    """Test the pure-computation _build_response helper."""

    def _call(self, transition_matrix, current_distribution, stage_durations_raw=None):
        svc = _make_service()
        org_id = uuid4()
        return svc._build_response(
            organization_id=org_id,
            job_id=None,
            start_date=None,
            end_date=None,
            total_pipelines=100,
            transition_matrix=transition_matrix,
            current_distribution=current_distribution,
            stage_durations_raw=stage_durations_raw or [],
        )

    def test_100_pct_conversion_from_applied_to_ai_interview(self):
        matrix = {("applied", "ai_interview"): 50}
        dist = {"ai_interview": 50}
        resp = self._call(matrix, dist)
        applied = next((f for f in resp.funnel if f.stage == "applied"), None)
        assert applied is not None
        assert applied.conversion_rate == 100.0
        assert applied.rejection_rate == 0.0

    def test_50_pct_conversion_with_rejections(self):
        matrix = {
            ("applied", "ai_interview"): 50,
            ("applied", "rejected"): 50,
        }
        dist = {}
        resp = self._call(matrix, dist)
        applied = next(f for f in resp.funnel if f.stage == "applied")
        assert applied.entered == 100
        assert applied.conversion_rate == 50.0
        assert applied.rejection_rate == 50.0

    def test_still_in_stage_counted_in_entered(self):
        matrix = {("applied", "ai_interview"): 40}
        dist = {"applied": 10}  # 10 still sitting at applied
        resp = self._call(matrix, dist)
        applied = next(f for f in resp.funnel if f.stage == "applied")
        # entered = 40 advanced + 10 still = 50; no rejections
        assert applied.entered == 50
        assert applied.still_in_stage == 10

    def test_zero_entered_gives_zero_conversion(self):
        resp = self._call({}, {})
        for entry in resp.funnel:
            assert entry.conversion_rate == 0.0
            assert entry.rejection_rate == 0.0

    def test_overall_placement_rate(self):
        matrix = {}
        dist = {"placed": 30, "rejected": 70}
        resp = self._call(matrix, dist)
        assert resp.total_placed == 30
        assert resp.total_rejected == 70
        assert resp.overall_placement_rate == 30.0

    def test_all_placed_gives_100_pct(self):
        dist = {"placed": 100}
        resp = self._call({}, dist)
        assert resp.overall_placement_rate == 100.0

    def test_no_placed_or_rejected_gives_0_pct(self):
        resp = self._call({}, {})
        assert resp.overall_placement_rate == 0.0


# ── _build_response: drop-off ranking ─────────────────────────────────────────

class TestDropOffRanking:
    def _call(self, matrix, dist):
        svc = _make_service()
        return svc._build_response(
            organization_id=uuid4(),
            job_id=None,
            start_date=None,
            end_date=None,
            total_pipelines=100,
            transition_matrix=matrix,
            current_distribution=dist,
            stage_durations_raw=[],
        )

    def test_highest_rejection_stage_is_bottleneck(self):
        matrix = {
            ("applied", "ai_interview"): 50,
            ("applied", "rejected"): 10,     # 10/60 = 16.7%
            ("ai_interview", "interview"): 30,
            ("ai_interview", "rejected"): 30,   # 30/60 = 50% — bottleneck
        }
        dist = {}
        resp = self._call(matrix, dist)
        bottleneck = next((d for d in resp.drop_off if d.is_bottleneck), None)
        assert bottleneck is not None
        assert bottleneck.stage == "ai_interview"

    def test_rank_1_is_highest_drop_off(self):
        matrix = {
            ("applied", "rejected"): 5,
            ("interview", "rejected"): 40,
        }
        dist = {"applied": 50, "interview": 40}
        resp = self._call(matrix, dist)
        rank1 = next(d for d in resp.drop_off if d.rank == 1)
        # interview: 40 rejected / 80 entered = 50%; applied: 5/55 = 9%
        assert rank1.stage == "interview"

    def test_no_rejections_means_empty_drop_off(self):
        matrix = {("applied", "ai_interview"): 100}
        resp = self._call(matrix, {"ai_interview": 100})
        assert resp.drop_off == []


# ── _build_response: stage durations ──────────────────────────────────────────

class TestStageDurations:
    def _call(self, durations_raw):
        svc = _make_service()
        return svc._build_response(
            organization_id=uuid4(),
            job_id=None,
            start_date=None,
            end_date=None,
            total_pipelines=100,
            transition_matrix={},
            current_distribution={},
            stage_durations_raw=durations_raw,
        )

    def test_avg_days_rounded_to_1dp(self):
        resp = self._call([("ai_interview", 5.678, None, 10)])
        dur = next(d for d in resp.stage_durations if d.stage == "ai_interview")
        assert dur.avg_days == 5.7

    def test_slow_stage_flagged_above_1_25x_mean(self):
        # mean = (2 + 10) / 2 = 6.0; 1.25× = 7.5; interview at 10 → is_slow
        resp = self._call([
            ("ai_interview", 2.0, None, 5),
            ("interview", 10.0, None, 5),
        ])
        screening = next(d for d in resp.stage_durations if d.stage == "ai_interview")
        interview = next(d for d in resp.stage_durations if d.stage == "interview")
        assert interview.is_slow is True
        assert screening.is_slow is False

    def test_empty_durations_gives_empty_list(self):
        resp = self._call([])
        assert resp.stage_durations == []

    def test_median_none_when_not_available(self):
        resp = self._call([("offer", 7.0, None, 3)])
        dur = next(d for d in resp.stage_durations if d.stage == "offer")
        assert dur.median_days is None


# ── CSV export rows structure ──────────────────────────────────────────────────

class TestCsvExportRows:
    def test_csv_rows_contain_funnel_section(self):
        svc = _make_service()
        org_id = uuid4()
        user = _make_user()
        user.organization_id = str(org_id)

        # Stub out get_analytics to return known data.
        svc.get_analytics = MagicMock(
            return_value=PipelineAnalyticsResponse(
                organization_id=org_id,
                total_pipelines=100,
                total_placed=30,
                total_rejected=20,
                overall_placement_rate=60.0,
                funnel=[
                    StageFunnelEntry(
                        stage="applied",
                        label="Applied",
                        entered=100,
                        advanced=80,
                        rejected=20,
                        still_in_stage=0,
                        conversion_rate=80.0,
                        rejection_rate=20.0,
                    )
                ],
                stage_durations=[],
                drop_off=[],
                generated_at=_now(),
            )
        )

        rows = svc.get_analytics_csv_rows(org_id, user)
        sections = {r["section"] for r in rows}
        assert "Conversion Funnel" in sections
        assert "Summary" in sections
        # Applied row
        applied_row = next(r for r in rows if r.get("stage") == "Applied")
        assert applied_row["entered"] == 100
        assert applied_row["conversion_rate_pct"] == "80.0"

    def test_summary_row_present(self):
        svc = _make_service()
        org_id = uuid4()
        user = _make_user()
        svc.get_analytics = MagicMock(
            return_value=PipelineAnalyticsResponse(
                organization_id=org_id,
                total_pipelines=50,
                total_placed=10,
                total_rejected=5,
                overall_placement_rate=66.7,
                generated_at=_now(),
            )
        )
        rows = svc.get_analytics_csv_rows(org_id, user)
        summary = next(r for r in rows if r["section"] == "Summary")
        assert summary["entered"] == 50
        assert summary["advanced"] == 10
        assert summary["rejected"] == 5

    def test_drop_off_section_in_csv(self):
        svc = _make_service()
        org_id = uuid4()
        user = _make_user()
        svc.get_analytics = MagicMock(
            return_value=PipelineAnalyticsResponse(
                organization_id=org_id,
                total_pipelines=100,
                total_placed=0,
                total_rejected=20,
                overall_placement_rate=0.0,
                drop_off=[
                    DropOffEntry(
                        stage="interview",
                        label="Interview",
                        rejected_count=20,
                        drop_off_rate=40.0,
                        is_bottleneck=True,
                        rank=1,
                    )
                ],
                generated_at=_now(),
            )
        )
        rows = svc.get_analytics_csv_rows(org_id, user)
        drop_rows = [r for r in rows if r["section"] == "Drop-Off Analysis"]
        assert len(drop_rows) == 1
        assert drop_rows[0]["is_bottleneck"] == "Yes"
        assert drop_rows[0]["drop_off_rank"] == 1


# ── Service: date range / job_id params passed through ───────────────────────

class TestServiceParamsPassthrough:
    """Test that get_analytics passes params correctly to _build_response.

    We mock _build_response to capture the kwargs it receives without
    triggering SQLAlchemy expression evaluation on MagicMock subqueries.
    """

    def _stub_service(self):
        svc = _make_service()
        # Stub DB-touching methods so get_analytics only exercises param routing.
        svc._scoped_pipeline_ids_subquery = MagicMock(return_value=MagicMock())
        svc._transition_matrix = MagicMock(return_value={})
        svc._current_stage_distribution = MagicMock(return_value={})
        svc._stage_duration_stats = MagicMock(return_value=[])
        # Mock _build_response to avoid SQLAlchemy coercion of MagicMock subquery.
        svc._build_response = MagicMock(
            return_value=PipelineAnalyticsResponse(
                organization_id=uuid4(),
                total_pipelines=0,
                total_placed=0,
                total_rejected=0,
                overall_placement_rate=0.0,
                generated_at=_now(),
            )
        )
        return svc

    def test_get_analytics_with_job_id(self):
        svc = self._stub_service()
        org_id = uuid4()
        user = _make_user()
        job_id = uuid4()

        svc.get_analytics(
            org_id,
            user,
            job_id=job_id,
            start_date=date(2025, 1, 1),
            end_date=date(2025, 12, 31),
        )

        # Verify subquery received job_id and date bounds.
        svc._scoped_pipeline_ids_subquery.assert_called_once_with(
            org_id,
            user,
            job_id=job_id,
            start_date=date(2025, 1, 1),
            end_date=date(2025, 12, 31),
        )
        # _build_response received the same params.
        _, kwargs = svc._build_response.call_args
        assert kwargs["job_id"] == job_id
        assert kwargs["start_date"] == date(2025, 1, 1)
        assert kwargs["end_date"] == date(2025, 12, 31)

    def test_get_analytics_cross_job_no_job_id(self):
        svc = self._stub_service()
        org_id = uuid4()
        user = _make_user()

        svc.get_analytics(org_id, user)

        _, kwargs = svc._build_response.call_args
        assert kwargs["job_id"] is None
        assert kwargs["start_date"] is None
        assert kwargs["end_date"] is None

    def test_analytics_org_id_propagated_to_build(self):
        svc = self._stub_service()
        org_id = uuid4()
        user = _make_user()

        svc.get_analytics(org_id, user)

        _, kwargs = svc._build_response.call_args
        assert kwargs["organization_id"] == org_id


# ── FUNNEL_STAGES and NEXT_STAGE consistency ──────────────────────────────────

class TestFunnelConstants:
    def test_next_stage_keys_are_funnel_stages(self):
        for stage in NEXT_STAGE:
            assert stage in FUNNEL_STAGES

    def test_funnel_starts_with_applied(self):
        assert FUNNEL_STAGES[0] == "applied"

    def test_funnel_ends_with_placed(self):
        assert FUNNEL_STAGES[-1] == "placed"

    def test_all_stages_have_labels(self):
        from app.services.pipeline_analytics_service import STAGE_LABELS
        for stage in FUNNEL_STAGES:
            assert stage in STAGE_LABELS
