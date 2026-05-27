from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import BackgroundTasks, HTTPException, status
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

_svc_log = logging.getLogger("airis.interview_service")

from app.models.candidate import Candidate
from app.models.interview import (
    Interview,
    InterviewFeedback,
    InterviewNote,
    InterviewParticipant,
    InterviewerProfile,
    InterviewerSkill,
    InterviewerAvailability,
)
from app.models.job import Job
from app.models.pipeline import Pipeline
from app.schemas.auth import CurrentUser
from app.schemas.interview import (
    AISummaryResponse,
    AISummaryUpdate,
    CandidateWorkspaceInfo,
    FeedbackSummary,
    InterviewCreate,
    InterviewFeedbackCreate,
    InterviewFeedbackResponse,
    InterviewParticipantCreate,
    InterviewParticipantResponse,
    InterviewResponse,
    InterviewStatus,
    InterviewUpdate,
    InterviewerProfileCreate,
    NoteResponse,
    NoteUpsert,
    QueueInterviewResponse,
    WorkspaceResponse,
)
from app.services.access_scope_service import AccessScopeService
from app.services.interview_notification_service import InterviewNotificationService
from app.services.interview_reminder_service import (
    cancel_all_reminders,
    cancel_participant_reminders,
    reschedule_reminders,
    schedule_candidate_reminders,
    schedule_interviewer_reminder,
)
from app.services.pipeline_service import PipelineService


ELIGIBLE_STAGES: frozenset[str] = frozenset({"screening", "interview", "offer", "placed"})


# ── AI-004: Background summary generation ───────────────────────────────────

def _run_summary_generation(interview_id: UUID) -> None:
    """Background task: generate AI summary and persist it to the interview row.

    Creates its own DB session (BackgroundTasks run in a thread pool, so the
    request-scoped session is no longer valid by the time this executes).
    """
    from app.db.session import SessionLocal
    from app.services.ai.interview_summary import generate_interview_summary

    db = SessionLocal()
    try:
        from sqlalchemy import select as _select
        from app.models.interview import Interview as _Interview

        interview = db.scalar(_select(_Interview).where(_Interview.id == interview_id))
        if interview is None:
            _svc_log.warning("_run_summary_generation: interview %s not found", interview_id)
            return

        _svc_log.info("ai_summary[%s]: starting generation", interview_id)
        summary, provider = generate_interview_summary(db, interview)

        interview.ai_summary = summary
        interview.ai_summary_generated_at = datetime.now(UTC)
        interview.ai_summary_provider = provider
        interview.ai_summary_edited = False
        db.add(interview)
        db.commit()
        _svc_log.info(
            "ai_summary[%s]: saved (provider=%s error=%s)",
            interview_id,
            provider,
            summary.get("error") if isinstance(summary, dict) else None,
        )
    except Exception:
        _svc_log.exception("ai_summary[%s]: unexpected failure in background task", interview_id)
        db.rollback()
    finally:
        db.close()

# Statuses shown in the interviewer queue
QUEUE_STATUSES: frozenset[str] = frozenset({
    InterviewStatus.PENDING_PANEL.value,
    InterviewStatus.SCHEDULED.value,
})


def _detect_meeting_provider(url: str | None) -> str | None:
    """Derive a canonical provider slug from the meeting link."""
    if not url:
        return None
    import re
    if re.search(r"meet\.google\.com", url):
        return "google_meet"
    if re.search(r"teams\.microsoft\.com|teams\.live\.com", url):
        return "teams"
    if re.search(r"zoom\.us", url):
        return "zoom"
    return "other"


def _assert_scheduled_not_in_past(scheduled_at: datetime) -> None:
    now = datetime.now(UTC)
    if scheduled_at < now:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="scheduled_at must not be in the past (times are interpreted in UTC).",
        )


def _assert_stage_eligible(pipeline: Pipeline) -> None:
    if pipeline.stage not in ELIGIBLE_STAGES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Interview scheduling requires the candidate to be at stage "
                f"'screening', 'interview', 'offer', or 'placed'. "
                f"Current stage is '{pipeline.stage}'."
            ),
        )


_VALID_TRANSITIONS: dict[str, frozenset[str]] = {
    InterviewStatus.SCHEDULED.value: frozenset({
        InterviewStatus.PENDING_PANEL.value,
        InterviewStatus.CONFIRMED.value,
        InterviewStatus.PANEL_CONFIRMED.value,
        InterviewStatus.IN_PROGRESS.value,
        InterviewStatus.COMPLETED.value,
        InterviewStatus.CANCELLED.value,
        InterviewStatus.NO_SHOW.value,
        InterviewStatus.RESCHEDULED.value,
        InterviewStatus.FEEDBACK_PENDING.value,
    }),
    InterviewStatus.PENDING_PANEL.value: frozenset({
        InterviewStatus.PANEL_CONFIRMED.value,
        InterviewStatus.SCHEDULED.value,   # downgrade if needed
        InterviewStatus.CANCELLED.value,
        InterviewStatus.RESCHEDULED.value,
    }),
    InterviewStatus.PANEL_CONFIRMED.value: frozenset({
        InterviewStatus.IN_PROGRESS.value,
        InterviewStatus.COMPLETED.value,
        InterviewStatus.CANCELLED.value,
        InterviewStatus.NO_SHOW.value,
        InterviewStatus.RESCHEDULED.value,
        InterviewStatus.FEEDBACK_PENDING.value,
    }),
    InterviewStatus.IN_PROGRESS.value: frozenset({
        InterviewStatus.COMPLETED.value,
        InterviewStatus.NO_SHOW.value,
        InterviewStatus.CANCELLED.value,
    }),
    InterviewStatus.CONFIRMED.value: frozenset({
        InterviewStatus.IN_PROGRESS.value,
        InterviewStatus.PANEL_CONFIRMED.value,
        InterviewStatus.COMPLETED.value,
        InterviewStatus.CANCELLED.value,
        InterviewStatus.NO_SHOW.value,
        InterviewStatus.RESCHEDULED.value,
        InterviewStatus.FEEDBACK_PENDING.value,
    }),
    InterviewStatus.RESCHEDULED.value: frozenset({
        InterviewStatus.SCHEDULED.value,
        InterviewStatus.PENDING_PANEL.value,
    }),
    InterviewStatus.FEEDBACK_PENDING.value: frozenset({
        InterviewStatus.COMPLETED.value,
        InterviewStatus.FEEDBACK_SUBMITTED.value,
    }),
    # Terminal + near-terminal
    InterviewStatus.COMPLETED.value: frozenset({
        InterviewStatus.FEEDBACK_PENDING.value,
        InterviewStatus.FEEDBACK_SUBMITTED.value,  # direct path when single reviewer
    }),
    InterviewStatus.FEEDBACK_SUBMITTED.value: frozenset(),
    InterviewStatus.CANCELLED.value: frozenset(),
    InterviewStatus.NO_SHOW.value: frozenset(),
}


def _validate_status_transition(current: str, new: str) -> None:
    if current == new:
        return
    allowed = _VALID_TRANSITIONS.get(current, frozenset())
    if new not in allowed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Invalid status transition from '{current}' to '{new}'. "
                f"Allowed: {', '.join(sorted(allowed)) or 'none (terminal state)'}."
            ),
        )


class InterviewService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self._scope = AccessScopeService(db)
        self._pipelines = PipelineService(db)
        self._notify = InterviewNotificationService()

    # ── Scoped query base ────────────────────────────────────────────────

    def _base_interview_stmt(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> Select[tuple[Interview]]:
        stmt = select(Interview).where(Interview.organization_id == organization_id)
        if self._scope.is_scoped_user(current_user):
            stmt = stmt.where(
                Interview.pipeline_id.in_(
                    select(Pipeline.id).where(
                        Pipeline.job_id.in_(self._scope.allowed_job_ids_subquery(current_user))
                    )
                )
            )
        return stmt

    # ── Core CRUD ────────────────────────────────────────────────────────

    def create_interview(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: InterviewCreate,
    ) -> Interview:
        pipeline = self._pipelines.get_pipeline_by_id(payload.pipeline_id, organization_id, current_user)
        _assert_stage_eligible(pipeline)
        _assert_scheduled_not_in_past(payload.scheduled_at)

        if payload.duration_minutes is not None and payload.duration_minutes <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="duration_minutes must be a positive integer.",
            )

        interview = Interview(
            organization_id=organization_id,
            pipeline_id=payload.pipeline_id,
            candidate_id=pipeline.candidate_id,
            job_id=pipeline.job_id,
            interview_type=payload.interview_type.value if payload.interview_type else None,
            meeting_type=payload.meeting_type.value if payload.meeting_type else None,
            meeting_provider=_detect_meeting_provider(payload.meeting_link),
            scheduled_at=payload.scheduled_at,
            duration_minutes=payload.duration_minutes,
            meeting_link=payload.meeting_link,
            location=payload.location,
            status=payload.status.value,
            interviewer_name=payload.interviewer_name.strip() if payload.interviewer_name else None,
            notes=payload.notes,
            created_by=UUID(current_user.user_id),
        )
        self.db.add(interview)
        self.db.commit()
        self.db.refresh(interview)

        self._notify.on_interview_scheduled(interview.id, organization_id)

        # SCHED-006: schedule candidate reminder rows
        if interview.candidate_id:
            candidate = self.db.scalar(
                select(Candidate).where(Candidate.id == interview.candidate_id)
            )
            if candidate and candidate.email:
                schedule_candidate_reminders(self.db, interview, candidate.email)
                self.db.commit()

        return interview

    def list_interviews(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
        *,
        limit: int = 50,
        offset: int = 0,
        pipeline_id: UUID | None = None,
        candidate_id: UUID | None = None,
        job_id: UUID | None = None,
        status_filter: str | None = None,
    ) -> list[Interview]:
        stmt = self._base_interview_stmt(organization_id, current_user)

        if pipeline_id is not None:
            stmt = stmt.where(Interview.pipeline_id == pipeline_id)
        if candidate_id is not None:
            stmt = stmt.where(Interview.candidate_id == candidate_id)
        if job_id is not None:
            stmt = stmt.where(Interview.job_id == job_id)
        if status_filter is not None:
            stmt = stmt.where(Interview.status == status_filter)

        stmt = stmt.order_by(Interview.scheduled_at.desc()).offset(offset).limit(limit)
        return list(self.db.scalars(stmt))

    def get_interview_by_id(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> Interview:
        stmt = self._base_interview_stmt(organization_id, current_user).where(
            Interview.id == interview_id,
        )
        interview = self.db.scalar(stmt)
        if interview is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Interview not found.",
            )
        return interview

    def update_interview(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: InterviewUpdate,
    ) -> Interview:
        interview = self.get_interview_by_id(interview_id, organization_id, current_user)

        update_data = payload.model_dump(exclude_unset=True)

        if "pipeline_id" in update_data:
            new_pipeline_id = update_data.pop("pipeline_id")
            if new_pipeline_id is None:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="pipeline_id cannot be null.")
            self._pipelines.get_pipeline_by_id(new_pipeline_id, organization_id, current_user)
            update_data["pipeline_id"] = new_pipeline_id

        if "scheduled_at" in update_data and update_data["scheduled_at"] is not None:
            _assert_scheduled_not_in_past(update_data["scheduled_at"])

        prev_status = interview.status
        if "status" in update_data and update_data["status"] is not None:
            new_status = update_data["status"].value
            _validate_status_transition(interview.status, new_status)
            update_data["status"] = new_status

        if "interview_type" in update_data and update_data["interview_type"] is not None:
            update_data["interview_type"] = update_data["interview_type"].value

        if "meeting_type" in update_data and update_data["meeting_type"] is not None:
            update_data["meeting_type"] = update_data["meeting_type"].value

        if "meeting_link" in update_data:
            update_data["meeting_provider"] = _detect_meeting_provider(update_data.get("meeting_link"))

        if "interviewer_name" in update_data and update_data["interviewer_name"] is not None:
            update_data["interviewer_name"] = str(update_data["interviewer_name"]).strip() or None

        for field, value in update_data.items():
            setattr(interview, field, value)

        self.db.add(interview)
        self.db.commit()
        self.db.refresh(interview)

        new_status_val = interview.status
        if prev_status != new_status_val:
            if new_status_val == InterviewStatus.CONFIRMED.value:
                self._notify.on_interview_confirmed(interview.id, organization_id)
            elif new_status_val == InterviewStatus.RESCHEDULED.value:
                self._notify.on_interview_rescheduled(interview.id, organization_id)
                # SCHED-006: cancel pending reminders — new ones scheduled below if
                # scheduled_at also changed; otherwise they will be created fresh on
                # the next status update that sets a new time.
                cancel_all_reminders(self.db, interview.id)
                self.db.commit()
            elif new_status_val == InterviewStatus.CANCELLED.value:
                self._notify.on_interview_cancelled(interview.id, organization_id)
                # SCHED-006: cancel all pending reminders
                cancel_all_reminders(self.db, interview.id)
                self.db.commit()

        # SCHED-006: if scheduled_at changed on a non-terminal interview, reschedule
        if "scheduled_at" in update_data and interview.status not in {
            InterviewStatus.CANCELLED.value,
            InterviewStatus.NO_SHOW.value,
        }:
            candidate_email: str | None = None
            if interview.candidate_id:
                candidate = self.db.scalar(
                    select(Candidate).where(Candidate.id == interview.candidate_id)
                )
                if candidate:
                    candidate_email = candidate.email
            reschedule_reminders(self.db, interview, candidate_email)
            self.db.commit()

        return interview

    def delete_interview(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> None:
        interview = self.get_interview_by_id(interview_id, organization_id, current_user)
        self.db.delete(interview)
        self.db.commit()

    # ── Queue ────────────────────────────────────────────────────────────

    def get_queue(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
        *,
        limit: int = 50,
        offset: int = 0,
        round_type: str | None = None,
        job_id: UUID | None = None,
    ) -> list[QueueInterviewResponse]:
        """Return interviews needing panelists, enriched with candidate/job names and participant count."""

        # Subquery: count accepted participants per interview
        pcount_sq = (
            select(
                InterviewParticipant.interview_id.label("interview_id"),
                func.count(InterviewParticipant.id).label("cnt"),
            )
            .where(InterviewParticipant.status == "accepted")
            .group_by(InterviewParticipant.interview_id)
            .subquery("pcount")
        )

        stmt = (
            select(
                Interview,
                Candidate.first_name,
                Candidate.last_name,
                Job.title,
                func.coalesce(pcount_sq.c.cnt, 0).label("participant_count"),
            )
            .join(Candidate, Interview.candidate_id == Candidate.id, isouter=True)
            .join(Job, Interview.job_id == Job.id, isouter=True)
            .outerjoin(pcount_sq, Interview.id == pcount_sq.c.interview_id)
            .where(Interview.organization_id == organization_id)
            .where(Interview.status.in_(QUEUE_STATUSES))
            .order_by(Interview.scheduled_at.asc())
        )

        if round_type:
            stmt = stmt.where(Interview.interview_type == round_type)
        if job_id:
            stmt = stmt.where(Interview.job_id == job_id)

        # AccessScope filtering for scoped users
        if self._scope.is_scoped_user(current_user):
            stmt = stmt.where(
                Interview.pipeline_id.in_(
                    select(Pipeline.id).where(
                        Pipeline.job_id.in_(self._scope.allowed_job_ids_subquery(current_user))
                    )
                )
            )

        rows = self.db.execute(stmt.offset(offset).limit(limit)).all()

        results: list[QueueInterviewResponse] = []
        for interview, first_name, last_name, job_title, participant_count in rows:
            resp = QueueInterviewResponse.model_validate(interview)
            resp.candidate_first_name = first_name
            resp.candidate_last_name = last_name
            resp.job_title = job_title
            resp.participant_count = int(participant_count or 0)
            results.append(resp)
        return results

    # ── My Interviews ────────────────────────────────────────────────────

    def get_my_interviews(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
        *,
        limit: int = 100,
        offset: int = 0,
    ) -> list[Interview]:
        """Return interviews where the current user is a participant."""
        user_uuid = UUID(current_user.user_id)
        stmt = (
            select(Interview)
            .join(
                InterviewParticipant,
                InterviewParticipant.interview_id == Interview.id,
            )
            .where(Interview.organization_id == organization_id)
            .where(InterviewParticipant.user_id == user_uuid)
            .where(InterviewParticipant.status != "declined")
            .order_by(Interview.scheduled_at.asc())
            .offset(offset)
            .limit(limit)
        )
        return list(self.db.scalars(stmt))

    # ── Panel management ─────────────────────────────────────────────────

    def claim_interview(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> InterviewParticipant:
        """Interviewer self-assigns as lead panelist. Advances status to panel_confirmed."""
        interview = self.get_interview_by_id(interview_id, organization_id, current_user)

        if interview.status not in QUEUE_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cannot claim an interview with status '{interview.status}'.",
            )

        user_uuid = UUID(current_user.user_id)

        # Prevent duplicate claim
        existing = self.db.scalar(
            select(InterviewParticipant).where(
                InterviewParticipant.interview_id == interview_id,
                InterviewParticipant.user_id == user_uuid,
            )
        )
        if existing is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="You have already claimed this interview.",
            )

        participant = InterviewParticipant(
            organization_id=organization_id,
            interview_id=interview_id,
            user_id=user_uuid,
            role="lead",
            participant_role="lead",
            status="accepted",
            joined_at=datetime.now(UTC),
        )
        self.db.add(participant)

        # Advance status: first lead claim → panel_confirmed
        if interview.status in {InterviewStatus.PENDING_PANEL.value, InterviewStatus.SCHEDULED.value}:
            interview.status = InterviewStatus.PANEL_CONFIRMED.value
            self.db.add(interview)

        self.db.commit()
        self.db.refresh(participant)

        # SCHED-006: schedule interviewer reminders for the claiming user
        from app.models.profile import Profile
        profile = self.db.scalar(select(Profile).where(Profile.id == user_uuid))
        if profile and profile.email:
            schedule_interviewer_reminder(self.db, interview, profile.email)
            self.db.commit()

        return participant

    def add_participant(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: InterviewParticipantCreate,
    ) -> InterviewParticipant:
        """Recruiter adds any user as a panelist."""
        self.get_interview_by_id(interview_id, organization_id, current_user)

        # Prevent duplicate
        existing = self.db.scalar(
            select(InterviewParticipant).where(
                InterviewParticipant.interview_id == interview_id,
                InterviewParticipant.user_id == payload.user_id,
            )
        )
        if existing is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="User is already a participant in this interview.",
            )

        participant = InterviewParticipant(
            organization_id=organization_id,
            interview_id=interview_id,
            user_id=payload.user_id,
            role=payload.participant_role.value,
            participant_role=payload.participant_role.value,
            status="invited",
        )
        self.db.add(participant)
        self.db.commit()
        self.db.refresh(participant)

        # SCHED-006: schedule interviewer reminders for the newly added participant
        interview = self.db.scalar(select(Interview).where(Interview.id == interview_id))
        if interview:
            from app.models.profile import Profile
            profile = self.db.scalar(
                select(Profile).where(Profile.id == payload.user_id)
            )
            if profile and profile.email:
                schedule_interviewer_reminder(self.db, interview, profile.email)
                self.db.commit()

        return participant

    def list_participants(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> list[InterviewParticipant]:
        self.get_interview_by_id(interview_id, organization_id, current_user)
        stmt = (
            select(InterviewParticipant)
            .where(InterviewParticipant.interview_id == interview_id)
            .order_by(InterviewParticipant.created_at.asc())
        )
        return list(self.db.scalars(stmt))

    def remove_participant(
        self,
        interview_id: UUID,
        participant_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> None:
        self.get_interview_by_id(interview_id, organization_id, current_user)
        participant = self.db.scalar(
            select(InterviewParticipant).where(
                InterviewParticipant.id == participant_id,
                InterviewParticipant.interview_id == interview_id,
            )
        )
        if participant is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Participant not found.")

        # SCHED-006: cancel this participant's pending reminders before deleting
        from app.models.profile import Profile
        profile = self.db.scalar(
            select(Profile).where(Profile.id == participant.user_id)
        )
        if profile and profile.email:
            cancel_participant_reminders(self.db, interview_id, profile.email)

        self.db.delete(participant)
        self.db.commit()

    # ── Feedback ─────────────────────────────────────────────────────────

    def create_feedback(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: InterviewFeedbackCreate,
    ) -> InterviewFeedback:
        interview = self.get_interview_by_id(interview_id, organization_id, current_user)

        # Feedback is unlocked once the session has ended.
        # feedback_submitted is also included so later panelists can still submit
        # after the first reviewer has already advanced the global status.
        feedback_allowed_statuses = {
            InterviewStatus.COMPLETED.value,
            InterviewStatus.FEEDBACK_PENDING.value,
            InterviewStatus.FEEDBACK_SUBMITTED.value,
        }
        if interview.status not in feedback_allowed_statuses:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Interview must be completed before feedback can be submitted. "
                    f"Current status is '{interview.status}'."
                ),
            )

        reviewer_id = UUID(current_user.user_id)

        existing = self.db.scalar(
            select(InterviewFeedback).where(
                InterviewFeedback.interview_id == interview_id,
                InterviewFeedback.reviewer_id == reviewer_id,
            )
        )
        if existing is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="You have already submitted feedback for this interview.",
            )

        now = datetime.now(UTC)
        feedback = InterviewFeedback(
            interview_id=interview_id,
            reviewer_id=reviewer_id,
            technical_score=payload.technical_score,
            communication_score=payload.communication_score,
            problem_solving_score=payload.problem_solving_score,
            culture_fit_score=payload.culture_fit_score,
            system_design_score=payload.system_design_score,
            leadership_score=payload.leadership_score,
            rating=payload.rating,
            recommendation=payload.recommendation.value if payload.recommendation else None,
            strengths=payload.strengths,
            weaknesses=payload.weaknesses,
            notes=payload.notes,
            submitted_at=now,
        )
        self.db.add(feedback)

        # Advance global status to feedback_submitted on first submission.
        # Skip if already there (multi-panel: later reviewers don't re-transition).
        if interview.status != InterviewStatus.FEEDBACK_SUBMITTED.value:
            _validate_status_transition(interview.status, InterviewStatus.FEEDBACK_SUBMITTED.value)
            interview.status = InterviewStatus.FEEDBACK_SUBMITTED.value
            self.db.add(interview)

        self.db.commit()
        self.db.refresh(feedback)

        self._notify.on_feedback_submitted(interview_id, organization_id)
        return feedback

    def get_feedback(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> list[InterviewFeedback]:
        self.get_interview_by_id(interview_id, organization_id, current_user)
        stmt = (
            select(InterviewFeedback)
            .where(InterviewFeedback.interview_id == interview_id)
            .order_by(InterviewFeedback.created_at.asc())
        )
        return list(self.db.scalars(stmt))

    # ── Interviewer profiles ──────────────────────────────────────────────

    def upsert_my_profile(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: InterviewerProfileCreate,
    ) -> InterviewerProfile:
        user_uuid = UUID(current_user.user_id)
        profile = self.db.scalar(
            select(InterviewerProfile).where(
                InterviewerProfile.organization_id == organization_id,
                InterviewerProfile.user_id == user_uuid,
            )
        )
        if profile is None:
            profile = InterviewerProfile(
                organization_id=organization_id,
                user_id=user_uuid,
            )
            self.db.add(profile)

        profile.title = payload.title
        profile.department = payload.department
        profile.is_active = payload.is_active
        profile.max_interviews_per_day = payload.max_interviews_per_day
        profile.timezone = payload.timezone
        profile.bio = payload.bio

        self.db.flush()

        # Replace skills
        self.db.execute(
            InterviewerSkill.__table__.delete().where(
                InterviewerSkill.interviewer_profile_id == profile.id
            )
        )
        for skill_name in payload.skills:
            self.db.add(InterviewerSkill(interviewer_profile_id=profile.id, skill=skill_name.strip()))

        self.db.commit()
        self.db.refresh(profile)
        return profile

    def get_my_profile(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> InterviewerProfile | None:
        user_uuid = UUID(current_user.user_id)
        return self.db.scalar(
            select(InterviewerProfile).where(
                InterviewerProfile.organization_id == organization_id,
                InterviewerProfile.user_id == user_uuid,
            )
        )

    def get_profile_skills(self, profile_id: UUID) -> list[str]:
        rows = self.db.scalars(
            select(InterviewerSkill.skill).where(
                InterviewerSkill.interviewer_profile_id == profile_id
            )
        )
        return list(rows)

    # ── Workspace ────────────────────────────────────────────────────────

    def get_workspace(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> WorkspaceResponse:
        interview = self.get_interview_by_id(interview_id, organization_id, current_user)

        candidate: Candidate | None = None
        if interview.candidate_id:
            candidate = self.db.scalar(
                select(Candidate).where(Candidate.id == interview.candidate_id)
            )

        job_title: str | None = None
        if interview.job_id:
            job = self.db.scalar(select(Job).where(Job.id == interview.job_id))
            job_title = job.title if job else None

        participants = list(
            self.db.scalars(
                select(InterviewParticipant)
                .where(InterviewParticipant.interview_id == interview_id)
                .order_by(InterviewParticipant.created_at.asc())
            )
        )

        notes = self._get_notes(interview_id, organization_id, current_user)
        feedback_summary = self._build_feedback_summary(interview_id)

        my_feedback = self.db.scalar(
            select(InterviewFeedback).where(
                InterviewFeedback.interview_id == interview_id,
                InterviewFeedback.reviewer_id == UUID(current_user.user_id),
            )
        )

        return WorkspaceResponse(
            interview=InterviewResponse.model_validate(interview),
            candidate=CandidateWorkspaceInfo.model_validate(candidate) if candidate else None,
            job_title=job_title,
            participants=[InterviewParticipantResponse.model_validate(p) for p in participants],
            notes=[NoteResponse.model_validate(n) for n in notes],
            feedback_summary=feedback_summary,
            my_feedback=InterviewFeedbackResponse.model_validate(my_feedback) if my_feedback else None,
        )

    # ── Notes ────────────────────────────────────────────────────────────

    def _get_notes(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> list[InterviewNote]:
        user_uuid = UUID(current_user.user_id)
        return list(
            self.db.scalars(
                select(InterviewNote)
                .where(
                    InterviewNote.interview_id == interview_id,
                    InterviewNote.interviewer_id == user_uuid,
                )
                .order_by(InterviewNote.created_at.asc())
            )
        )

    def get_notes(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> list[InterviewNote]:
        self.get_interview_by_id(interview_id, organization_id, current_user)
        return self._get_notes(interview_id, organization_id, current_user)

    def upsert_note(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: NoteUpsert,
    ) -> InterviewNote:
        self.get_interview_by_id(interview_id, organization_id, current_user)
        user_uuid = UUID(current_user.user_id)
        now = datetime.now(UTC)

        # One note per (interview, interviewer, section); upsert by section
        existing = self.db.scalar(
            select(InterviewNote).where(
                InterviewNote.interview_id == interview_id,
                InterviewNote.interviewer_id == user_uuid,
                InterviewNote.section == payload.section,
            )
        )

        if existing is not None:
            existing.content = payload.content
            existing.finalized = payload.finalized
            existing.autosaved_at = now if not payload.finalized else existing.autosaved_at
            existing.updated_at = now
            self.db.add(existing)
            self.db.commit()
            self.db.refresh(existing)
            return existing

        note = InterviewNote(
            interview_id=interview_id,
            interviewer_id=user_uuid,
            organization_id=organization_id,
            section=payload.section,
            content=payload.content,
            finalized=payload.finalized,
            autosaved_at=now if not payload.finalized else None,
        )
        self.db.add(note)
        self.db.commit()
        self.db.refresh(note)
        return note

    # ── Status controls ──────────────────────────────────────────────────

    def start_interview(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> Interview:
        interview = self.get_interview_by_id(interview_id, organization_id, current_user)
        _validate_status_transition(interview.status, InterviewStatus.IN_PROGRESS.value)
        interview.status = InterviewStatus.IN_PROGRESS.value
        if interview.started_at is None:
            interview.started_at = datetime.now(UTC)
        self.db.add(interview)
        self.db.commit()
        self.db.refresh(interview)
        return interview

    def complete_interview(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        background_tasks: BackgroundTasks | None = None,
    ) -> Interview:
        interview = self.get_interview_by_id(interview_id, organization_id, current_user)
        _validate_status_transition(interview.status, InterviewStatus.COMPLETED.value)
        interview.status = InterviewStatus.COMPLETED.value
        interview.ended_at = datetime.now(UTC)
        self.db.add(interview)
        self.db.commit()
        self.db.refresh(interview)

        # AI-004: trigger summary generation as a background task
        if background_tasks is not None:
            background_tasks.add_task(_run_summary_generation, interview_id)

        return interview

    def mark_no_show(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> Interview:
        interview = self.get_interview_by_id(interview_id, organization_id, current_user)
        _validate_status_transition(interview.status, InterviewStatus.NO_SHOW.value)
        interview.status = InterviewStatus.NO_SHOW.value
        self.db.add(interview)
        self.db.commit()
        self.db.refresh(interview)
        return interview

    # ── Reminders (SCHED-006) ───────────────────────────────────────────

    def get_reminders(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> list:
        """Return all reminder rows for an interview."""
        from app.services.interview_reminder_service import get_reminders_for_interview

        self.get_interview_by_id(interview_id, organization_id, current_user)
        return get_reminders_for_interview(self.db, interview_id)

    # ── AI Summary (AI-004) ──────────────────────────────────────────────

    def get_ai_summary(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> AISummaryResponse:
        interview = self.get_interview_by_id(interview_id, organization_id, current_user)
        return AISummaryResponse(
            interview_id=interview.id,
            ai_summary=interview.ai_summary,
            ai_summary_generated_at=interview.ai_summary_generated_at,
            ai_summary_provider=interview.ai_summary_provider,
            ai_summary_edited=interview.ai_summary_edited,
        )

    def regenerate_ai_summary(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        background_tasks: BackgroundTasks,
    ) -> dict:
        """Manually re-trigger summary generation for an already-completed interview."""
        interview = self.get_interview_by_id(interview_id, organization_id, current_user)
        if interview.status not in {
            InterviewStatus.COMPLETED.value,
            InterviewStatus.FEEDBACK_PENDING.value,
            InterviewStatus.FEEDBACK_SUBMITTED.value,
        }:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Summary generation is only available for completed interviews. "
                    f"Current status is '{interview.status}'."
                ),
            )
        background_tasks.add_task(_run_summary_generation, interview_id)
        return {"status": "generating", "interview_id": str(interview_id)}

    def update_ai_summary(
        self,
        interview_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: AISummaryUpdate,
    ) -> AISummaryResponse:
        """Allow recruiters to edit the AI-generated summary."""
        interview = self.get_interview_by_id(interview_id, organization_id, current_user)

        # Merge edits into the existing summary dict (or start fresh)
        current: dict = dict(interview.ai_summary) if isinstance(interview.ai_summary, dict) else {}

        update_data = payload.model_dump(exclude_unset=True)
        if "recommendation" in update_data and update_data["recommendation"] is not None:
            update_data["recommendation"] = update_data["recommendation"].value

        current.update(update_data)
        interview.ai_summary = current
        interview.ai_summary_edited = True
        self.db.add(interview)
        self.db.commit()
        self.db.refresh(interview)

        return AISummaryResponse(
            interview_id=interview.id,
            ai_summary=interview.ai_summary,
            ai_summary_generated_at=interview.ai_summary_generated_at,
            ai_summary_provider=interview.ai_summary_provider,
            ai_summary_edited=interview.ai_summary_edited,
        )

    # ── Feedback summary ─────────────────────────────────────────────────

    def _build_feedback_summary(self, interview_id: UUID) -> FeedbackSummary | None:
        feedback_rows = list(
            self.db.scalars(
                select(InterviewFeedback).where(InterviewFeedback.interview_id == interview_id)
            )
        )
        if not feedback_rows:
            return None

        def _avg(values: list[int | None]) -> float | None:
            real = [v for v in values if v is not None]
            return round(sum(real) / len(real), 2) if real else None

        score_dims = [
            "technical_score",
            "communication_score",
            "problem_solving_score",
            "culture_fit_score",
            "system_design_score",
            "leadership_score",
            "rating",
        ]

        recommendations: dict[str, int] = {}
        for fb in feedback_rows:
            if fb.recommendation:
                recommendations[fb.recommendation] = recommendations.get(fb.recommendation, 0) + 1

        return FeedbackSummary(
            count=len(feedback_rows),
            avg_technical=_avg([fb.technical_score for fb in feedback_rows]),
            avg_communication=_avg([fb.communication_score for fb in feedback_rows]),
            avg_problem_solving=_avg([fb.problem_solving_score for fb in feedback_rows]),
            avg_culture_fit=_avg([fb.culture_fit_score for fb in feedback_rows]),
            avg_system_design=_avg([getattr(fb, "system_design_score", None) for fb in feedback_rows]),
            avg_leadership=_avg([getattr(fb, "leadership_score", None) for fb in feedback_rows]),
            avg_overall=_avg([fb.rating for fb in feedback_rows]),
            recommendations=recommendations,
        )
