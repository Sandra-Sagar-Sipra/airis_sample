"""Unit tests for PIPE-002: Pipeline Stage Transition logic.

Tests cover:
- VALID_TRANSITIONS map completeness
- Valid forward transitions
- Invalid/blocked transitions → 422
- Rejection reason enforcement (schema validation)
- Terminal stage protection (placed/rejected have no outbound transitions)
- History row creation
- Stage normalisation (strip + lowercase)
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, call, patch
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.schemas.pipeline import PipelineStage, PipelineStageTransitionRequest
from app.services.pipeline_service import VALID_TRANSITIONS


# ── VALID_TRANSITIONS map ─────────────────────────────────────────────────────

class TestValidTransitionsMap:
    def test_all_stages_present(self):
        """Every PipelineStage enum value must have an entry in VALID_TRANSITIONS."""
        for stage in PipelineStage:
            assert stage.value in VALID_TRANSITIONS, f"Missing transitions for stage: {stage.value}"

    def test_terminal_stages_have_no_outbound(self):
        for terminal in (PipelineStage.PLACED, PipelineStage.REJECTED):
            assert VALID_TRANSITIONS[terminal.value] == frozenset(), \
                f"{terminal.value} should be terminal (no outbound transitions)"

    def test_applied_can_go_to_ai_interview_or_rejected(self):
        assert "ai_interview" in VALID_TRANSITIONS["applied"]
        assert "rejected" in VALID_TRANSITIONS["applied"]
        assert "interview" not in VALID_TRANSITIONS["applied"]
        assert "offer" not in VALID_TRANSITIONS["applied"]

    def test_ai_interview_can_go_to_interview_or_rejected(self):
        assert "interview" in VALID_TRANSITIONS["ai_interview"]
        assert "rejected" in VALID_TRANSITIONS["ai_interview"]
        assert "offer" not in VALID_TRANSITIONS["ai_interview"]

    def test_interview_can_go_to_offer_or_rejected(self):
        assert "offer" in VALID_TRANSITIONS["interview"]
        assert "rejected" in VALID_TRANSITIONS["interview"]
        assert "placed" not in VALID_TRANSITIONS["interview"]

    def test_offer_can_go_to_placed_or_rejected(self):
        assert "placed" in VALID_TRANSITIONS["offer"]
        assert "rejected" in VALID_TRANSITIONS["offer"]

    def test_cannot_skip_stages(self):
        # applied cannot jump straight to interview, offer, or placed
        assert "interview" not in VALID_TRANSITIONS["applied"]
        assert "offer" not in VALID_TRANSITIONS["applied"]
        assert "placed" not in VALID_TRANSITIONS["applied"]

    def test_cannot_revert_stage(self):
        # No stage can go back to "applied"
        for stage, targets in VALID_TRANSITIONS.items():
            assert "applied" not in targets, \
                f"Stage '{stage}' should not be able to revert to 'applied'"


# ── Schema validation ─────────────────────────────────────────────────────────

class TestPipelineStageTransitionRequestSchema:
    def test_valid_transition_without_reason(self):
        req = PipelineStageTransitionRequest(stage="ai_interview")
        assert req.stage == PipelineStage.AI_INTERVIEW
        assert req.reason is None

    def test_stage_normalised_lowercase(self):
        req = PipelineStageTransitionRequest(stage="  INTERVIEW  ")
        assert req.stage == PipelineStage.INTERVIEW

    def test_rejected_requires_reason(self):
        with pytest.raises(ValidationError) as exc_info:
            PipelineStageTransitionRequest(stage="rejected")
        errors = exc_info.value.errors()
        assert any("rejection reason" in str(e).lower() for e in errors)

    def test_rejected_reason_too_short(self):
        with pytest.raises(ValidationError):
            PipelineStageTransitionRequest(stage="rejected", reason="Too short")  # < 10 chars

    def test_rejected_with_sufficient_reason_passes(self):
        req = PipelineStageTransitionRequest(
            stage="rejected",
            reason="Not a good fit for the role at this time."
        )
        assert req.stage == PipelineStage.REJECTED
        assert req.reason is not None
        assert len(req.reason.strip()) >= 10

    def test_rejected_reason_whitespace_only_fails(self):
        with pytest.raises(ValidationError):
            PipelineStageTransitionRequest(stage="rejected", reason="          ")

    def test_placed_does_not_require_reason(self):
        req = PipelineStageTransitionRequest(stage="placed")
        assert req.stage == PipelineStage.PLACED


# ── Service transition method ─────────────────────────────────────────────────

def _make_pipeline(stage: str, org_id=None, pipeline_id=None) -> MagicMock:
    p = MagicMock()
    p.id = pipeline_id or uuid4()
    p.organization_id = org_id or uuid4()
    p.stage = stage
    p.status = "active"
    return p


def _make_current_user(user_id=None, org_id=None) -> MagicMock:
    u = MagicMock()
    u.user_id = str(user_id or uuid4())
    u.organization_id = str(org_id or uuid4())
    return u


class TestPipelineServiceTransitionStage:
    """
    Tests for PipelineService.transition_stage.
    DB interactions are stubbed so these are pure unit tests.
    """

    def _make_service(self, pipeline: Any):
        """Return a PipelineService with a stub db and get_pipeline_by_id returning `pipeline`."""
        from app.services.pipeline_service import PipelineService

        db = MagicMock()
        db.add = MagicMock()
        db.commit = MagicMock()
        db.refresh = MagicMock(side_effect=lambda x: x)

        svc = PipelineService.__new__(PipelineService)
        svc.db = db
        svc._scope = MagicMock()
        svc._candidates = MagicMock()
        svc.get_pipeline_by_id = MagicMock(return_value=pipeline)
        return svc

    def test_valid_transition_applied_to_ai_interview(self):
        pipeline = _make_pipeline("applied")
        svc = self._make_service(pipeline)
        user = _make_current_user()
        payload = PipelineStageTransitionRequest(stage="ai_interview")

        with patch("app.services.pipeline_service._notify_stage_change"):
            result = svc.transition_stage(pipeline.id, pipeline.organization_id, user, payload)

        assert pipeline.stage == "ai_interview"
        svc.db.commit.assert_called_once()

    def test_valid_transition_interview_to_offer(self):
        pipeline = _make_pipeline("interview")
        svc = self._make_service(pipeline)
        user = _make_current_user()
        payload = PipelineStageTransitionRequest(stage="offer")

        with patch("app.services.pipeline_service._notify_stage_change"):
            svc.transition_stage(pipeline.id, pipeline.organization_id, user, payload)

        assert pipeline.stage == "offer"

    def test_valid_transition_offer_to_placed_closes_pipeline(self):
        pipeline = _make_pipeline("offer")
        svc = self._make_service(pipeline)
        user = _make_current_user()
        payload = PipelineStageTransitionRequest(stage="placed")

        with patch("app.services.pipeline_service._notify_stage_change"):
            svc.transition_stage(pipeline.id, pipeline.organization_id, user, payload)

        assert pipeline.stage == "placed"
        assert pipeline.status == "closed"

    def test_valid_rejection_closes_pipeline(self):
        pipeline = _make_pipeline("interview")
        svc = self._make_service(pipeline)
        user = _make_current_user()
        payload = PipelineStageTransitionRequest(
            stage="rejected",
            reason="Candidate lacks required technical depth for the role."
        )

        with patch("app.services.pipeline_service._notify_stage_change"):
            svc.transition_stage(pipeline.id, pipeline.organization_id, user, payload)

        assert pipeline.stage == "rejected"
        assert pipeline.status == "closed"

    def test_invalid_transition_raises_422(self):
        pipeline = _make_pipeline("applied")
        svc = self._make_service(pipeline)
        user = _make_current_user()
        # applied → interview is NOT allowed
        payload = PipelineStageTransitionRequest(stage="interview")

        with pytest.raises(HTTPException) as exc_info:
            with patch("app.services.pipeline_service._notify_stage_change"):
                svc.transition_stage(pipeline.id, pipeline.organization_id, user, payload)

        assert exc_info.value.status_code == 422
        assert "applied" in exc_info.value.detail
        assert "interview" in exc_info.value.detail

    def test_terminal_placed_cannot_transition(self):
        pipeline = _make_pipeline("placed")
        svc = self._make_service(pipeline)
        user = _make_current_user()
        payload = PipelineStageTransitionRequest(stage="rejected", reason="Changed mind completely.")

        with pytest.raises(HTTPException) as exc_info:
            with patch("app.services.pipeline_service._notify_stage_change"):
                svc.transition_stage(pipeline.id, pipeline.organization_id, user, payload)

        assert exc_info.value.status_code == 422
        assert "terminal" in exc_info.value.detail.lower() or "none" in exc_info.value.detail.lower()

    def test_terminal_rejected_cannot_transition(self):
        pipeline = _make_pipeline("rejected")
        svc = self._make_service(pipeline)
        user = _make_current_user()
        payload = PipelineStageTransitionRequest(stage="ai_interview")

        with pytest.raises(HTTPException) as exc_info:
            with patch("app.services.pipeline_service._notify_stage_change"):
                svc.transition_stage(pipeline.id, pipeline.organization_id, user, payload)

        assert exc_info.value.status_code == 422

    def test_history_row_written(self):
        pipeline = _make_pipeline("ai_interview")
        svc = self._make_service(pipeline)
        user = _make_current_user()
        payload = PipelineStageTransitionRequest(stage="interview")

        with patch("app.services.pipeline_service._notify_stage_change"):
            svc.transition_stage(pipeline.id, pipeline.organization_id, user, payload)

        # db.add must have been called with a PipelineStageHistory instance.
        from app.models.pipeline import PipelineStageHistory

        added_objects = [c.args[0] for c in svc.db.add.call_args_list]
        history_rows = [o for o in added_objects if isinstance(o, PipelineStageHistory)]
        assert len(history_rows) == 1
        assert history_rows[0].previous_stage == "ai_interview"
        assert history_rows[0].new_stage == "interview"

    def test_notification_not_blocking(self):
        """_notify_stage_change failure must not abort the transition."""
        pipeline = _make_pipeline("applied")
        svc = self._make_service(pipeline)
        user = _make_current_user()
        payload = PipelineStageTransitionRequest(stage="ai_interview")

        with patch(
            "app.services.pipeline_service._notify_stage_change",
            side_effect=Exception("SMTP down"),
        ):
            # Should NOT raise — notification is best-effort.
            svc.transition_stage(pipeline.id, pipeline.organization_id, user, payload)

        assert pipeline.stage == "ai_interview"
