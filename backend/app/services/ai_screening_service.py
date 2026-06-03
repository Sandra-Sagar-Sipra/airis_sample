"""AI Screening Service — orchestrates the full screening lifecycle.

Workflow:
  1. create_screening()  → creates AIScreening row with status=pending
  2. generate_questions() → calls QuestionGenerator, persists questions, status=questions_ready
  3. upsert_answer()     → recruiter enters/updates an answer for a question
  4. run_evaluation()    → evaluates each answered question, computes scores, status=completed
  5. get_detail()        → returns full screening + Q+A+evaluations for recruiter review
  6. record_recruiter_decision() → stores recruiter override decision

generate_questions() and run_evaluation() are designed to be called from
FastAPI BackgroundTasks so they never block HTTP responses.

All errors are caught and persisted as status=failed so recruiters can retry.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.ai_screening import (
    AIScreening,
    AIScreeningAnswer,
    AIScreeningEvaluation,
    AIScreeningQuestion,
)
from app.models.candidate import Candidate
from app.models.job import Job
from app.schemas.ai_screening import (
    AIScreeningCreate,
    AIScreeningDetailResponse,
    AIScreeningListItem,
    AIScreeningQuestionResponse,
    AIScreeningAnswerResponse,
    AIScreeningEvaluationResponse,
    AIScreeningResponse,
    AnswerUpsert,
)
from app.schemas.auth import CurrentUser
from app.services.ai.answer_evaluator import AnswerEvaluator
from app.services.ai.question_generator import QuestionGenerator
from app.services.ai.recommendation_engine import compute_scores_and_recommendation
from app.services.ai.recruiter_summary import RecruiterSummaryGenerator

logger = logging.getLogger(__name__)


class AIScreeningService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self._question_gen = QuestionGenerator()
        self._evaluator = AnswerEvaluator()
        self._summarizer = RecruiterSummaryGenerator()

    # ── Create ────────────────────────────────────────────────────────────────

    def create_screening(
        self,
        org_id: UUID,
        current_user: CurrentUser,
        payload: AIScreeningCreate,
    ) -> AIScreening:
        screening = AIScreening(
            organization_id=org_id,
            candidate_id=payload.candidate_id,
            job_id=payload.job_id,
            created_by=UUID(current_user.user_id),
            status="pending",
            screening_type=payload.screening_type.value,
        )
        self.db.add(screening)
        self.db.commit()
        self.db.refresh(screening)
        return screening

    # ── List ─────────────────────────────────────────────────────────────────

    def list_screenings(
        self,
        org_id: UUID,
        *,
        candidate_id: UUID | None = None,
        job_id: UUID | None = None,
        status: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[AIScreeningListItem]:
        stmt = (
            select(AIScreening)
            .where(AIScreening.organization_id == org_id)
            .order_by(AIScreening.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        if candidate_id:
            stmt = stmt.where(AIScreening.candidate_id == candidate_id)
        if job_id:
            stmt = stmt.where(AIScreening.job_id == job_id)
        if status:
            stmt = stmt.where(AIScreening.status == status)

        rows = list(self.db.scalars(stmt))
        items: list[AIScreeningListItem] = []
        for row in rows:
            candidate = self.db.get(Candidate, row.candidate_id)
            job = self.db.get(Job, row.job_id) if row.job_id else None
            items.append(
                AIScreeningListItem(
                    id=row.id,
                    candidate_id=row.candidate_id,
                    job_id=row.job_id,
                    status=row.status,
                    screening_type=row.screening_type,
                    overall_score=float(row.overall_score) if row.overall_score is not None else None,
                    recommendation=row.recommendation,
                    recruiter_decision=row.recruiter_decision,
                    created_at=row.created_at,
                    completed_at=row.completed_at,
                    candidate_name=f"{candidate.first_name} {candidate.last_name}" if candidate else None,
                    candidate_email=candidate.email if candidate else None,
                    job_title=job.title if job else None,
                )
            )
        return items

    # ── Get detail ────────────────────────────────────────────────────────────

    def get_screening(self, org_id: UUID, screening_id: UUID) -> AIScreening:
        row = self.db.scalar(
            select(AIScreening).where(
                AIScreening.id == screening_id,
                AIScreening.organization_id == org_id,
            )
        )
        if row is None:
            from fastapi import HTTPException, status as http_status
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Screening not found")
        return row

    def get_screening_detail(
        self, org_id: UUID, screening_id: UUID
    ) -> AIScreeningDetailResponse:
        screening = self.get_screening(org_id, screening_id)

        questions = list(
            self.db.scalars(
                select(AIScreeningQuestion)
                .where(AIScreeningQuestion.screening_id == screening_id)
                .order_by(AIScreeningQuestion.position)
            )
        )
        answers = list(
            self.db.scalars(
                select(AIScreeningAnswer)
                .where(AIScreeningAnswer.screening_id == screening_id)
            )
        )
        evaluations = list(
            self.db.scalars(
                select(AIScreeningEvaluation)
                .where(AIScreeningEvaluation.screening_id == screening_id)
            )
        )

        candidate = self.db.get(Candidate, screening.candidate_id)
        job = self.db.get(Job, screening.job_id) if screening.job_id else None

        # Fetch ATS score if available
        ats_score = None
        ats_recommendation = None
        try:
            from app.models.candidate_job_match import CandidateJobMatch
            if screening.job_id:
                match = self.db.scalar(
                    select(CandidateJobMatch).where(
                        CandidateJobMatch.candidate_id == screening.candidate_id,
                        CandidateJobMatch.job_id == screening.job_id,
                    )
                )
                if match:
                    ats_score = float(match.final_score) if match.final_score is not None else None
                    ats_recommendation = match.recommendation
        except Exception:
            pass  # ATS data is supplemental — never break the screening view

        return AIScreeningDetailResponse(
            **AIScreeningResponse.model_validate(screening).model_dump(),
            questions=[AIScreeningQuestionResponse.model_validate(q) for q in questions],
            answers=[AIScreeningAnswerResponse.model_validate(a) for a in answers],
            evaluations=[AIScreeningEvaluationResponse.model_validate(e) for e in evaluations],
            candidate_name=f"{candidate.first_name} {candidate.last_name}" if candidate else None,
            candidate_email=candidate.email if candidate else None,
            job_title=job.title if job else None,
            ats_score=ats_score,
            ats_recommendation=ats_recommendation,
        )

    # ── Generate questions (designed for BackgroundTasks) ────────────────────

    def generate_questions(self, org_id: UUID, screening_id: UUID) -> None:
        """Generate AI questions for a screening. Safe to call from background."""
        try:
            screening = self.get_screening(org_id, screening_id)
            screening.status = "generating_questions"
            self.db.add(screening)
            self.db.commit()

            # Load context
            candidate = self.db.get(Candidate, screening.candidate_id)
            job = self.db.get(Job, screening.job_id) if screening.job_id else None

            # Resolve seniority from candidate data
            seniority = _infer_seniority(candidate)
            candidate_skills: list[str] = []
            ats_gaps: list[str] = []

            if candidate:
                parsed = getattr(candidate, "parsed_resume_data", None) or {}
                candidate_skills = (
                    (parsed.get("skills") or []) + (parsed.get("inferred_skills") or [])
                )[:20]

            # Pull ATS skill gaps if available
            if job and candidate:
                try:
                    from app.models.candidate_job_match import CandidateJobMatch
                    match = self.db.scalar(
                        select(CandidateJobMatch).where(
                            CandidateJobMatch.candidate_id == candidate.id,
                            CandidateJobMatch.job_id == job.id,
                        )
                    )
                    if match and match.score_breakdown:
                        breakdown = match.score_breakdown or {}
                        ats_gaps = breakdown.get("missing_skills", [])[:10]
                except Exception:
                    pass

            result = self._question_gen.generate(
                job_title=job.title if job else "Unknown Role",
                job_description=job.description if job else "",
                screening_type=screening.screening_type,
                candidate_experience_summary=getattr(candidate, "experience_summary", "") or "",
                candidate_skills=candidate_skills,
                ats_gaps=ats_gaps,
                seniority=seniority,
            )

            # Persist questions
            for q in result.questions:
                self.db.add(
                    AIScreeningQuestion(
                        screening_id=screening_id,
                        category=q.category,
                        difficulty=q.difficulty,
                        position=q.position,
                        question_text=q.question_text,
                        expected_signals=q.expected_signals,
                        generated_by_ai=not result.fallback_used,
                    )
                )

            screening.status = "questions_ready"
            screening.ai_model = result.model
            screening.prompt_tokens_used = (screening.prompt_tokens_used or 0) + result.prompt_tokens
            screening.completion_tokens_used = (screening.completion_tokens_used or 0) + result.completion_tokens
            screening.generation_context = {
                "seniority": seniority,
                "skills_used": candidate_skills[:10],
                "ats_gaps_used": ats_gaps[:5],
                "fallback_used": result.fallback_used,
            }
            self.db.add(screening)
            self.db.commit()
            logger.info("screening.questions_generated screening_id=%s count=%d", screening_id, len(result.questions))

        except Exception as exc:
            logger.exception("screening.generate_questions.failed screening_id=%s: %s", screening_id, exc)
            try:
                screening = self.db.get(AIScreening, screening_id)
                if screening:
                    screening.status = "failed"
                    self.db.add(screening)
                    self.db.commit()
            except Exception:
                pass

    # ── Answers ───────────────────────────────────────────────────────────────

    def upsert_answer(
        self,
        org_id: UUID,
        screening_id: UUID,
        question_id: UUID,
        payload: AnswerUpsert,
    ) -> AIScreeningAnswer:
        """Create or replace the answer for a question."""
        self.get_screening(org_id, screening_id)  # ownership check

        existing = self.db.scalar(
            select(AIScreeningAnswer).where(
                AIScreeningAnswer.screening_id == screening_id,
                AIScreeningAnswer.question_id == question_id,
            )
        )
        if existing:
            existing.answer_text = payload.answer_text
            existing.source_type = payload.source_type.value
            self.db.add(existing)
            self.db.commit()
            self.db.refresh(existing)
            return existing

        answer = AIScreeningAnswer(
            screening_id=screening_id,
            question_id=question_id,
            answer_text=payload.answer_text,
            recruiter_entered=True,
            source_type=payload.source_type.value,
        )
        self.db.add(answer)
        self.db.commit()
        self.db.refresh(answer)
        return answer

    # ── Evaluate (designed for BackgroundTasks) ───────────────────────────────

    def run_evaluation(self, org_id: UUID, screening_id: UUID) -> None:
        """Evaluate all answered questions. Safe to call from background."""
        try:
            screening = self.get_screening(org_id, screening_id)
            screening.status = "evaluating"
            self.db.add(screening)
            self.db.commit()

            job = self.db.get(Job, screening.job_id) if screening.job_id else None
            candidate = self.db.get(Candidate, screening.candidate_id)
            job_title = job.title if job else "Unknown Role"

            questions = list(
                self.db.scalars(
                    select(AIScreeningQuestion)
                    .where(AIScreeningQuestion.screening_id == screening_id)
                    .order_by(AIScreeningQuestion.position)
                )
            )
            answers_by_qid: dict[UUID, AIScreeningAnswer] = {}
            for ans in self.db.scalars(
                select(AIScreeningAnswer).where(AIScreeningAnswer.screening_id == screening_id)
            ):
                answers_by_qid[ans.question_id] = ans

            total_prompt_tokens = 0
            total_completion_tokens = 0
            eval_dicts: list[dict] = []
            qa_for_summary: list[dict] = []

            for question in questions:
                answer = answers_by_qid.get(question.id)
                if not answer:
                    continue

                # Remove stale evaluation if exists
                old_eval = self.db.scalar(
                    select(AIScreeningEvaluation).where(
                        AIScreeningEvaluation.screening_id == screening_id,
                        AIScreeningEvaluation.question_id == question.id,
                    )
                )
                if old_eval:
                    self.db.delete(old_eval)
                    self.db.flush()

                result = self._evaluator.evaluate(
                    job_title=job_title,
                    question_text=question.question_text,
                    question_category=question.category,
                    expected_signals=question.expected_signals,
                    answer_text=answer.answer_text,
                )

                eval_row = AIScreeningEvaluation(
                    screening_id=screening_id,
                    question_id=question.id,
                    ai_score=result.ai_score,
                    communication_rating=result.communication_rating,
                    technical_rating=result.technical_rating,
                    strengths=result.strengths,
                    concerns=result.concerns,
                    reasoning=result.reasoning,
                    follow_up_suggestion=result.follow_up_suggestion,
                    confidence=result.confidence,
                )
                self.db.add(eval_row)
                total_prompt_tokens += result.prompt_tokens
                total_completion_tokens += result.completion_tokens

                eval_dicts.append({
                    "ai_score": result.ai_score,
                    "communication_rating": result.communication_rating,
                    "technical_rating": result.technical_rating,
                    "confidence": result.confidence,
                })
                qa_for_summary.append({
                    "question": question.question_text,
                    "category": question.category,
                    "ai_score": result.ai_score,
                    "strengths": result.strengths,
                    "concerns": result.concerns,
                })

            self.db.flush()

            # Compute aggregate scores
            scores = compute_scores_and_recommendation(
                evaluations=eval_dicts,
                screening_type=screening.screening_type,
            )

            # Generate recruiter summary
            candidate_name = (
                f"{candidate.first_name} {candidate.last_name}" if candidate else "Candidate"
            )
            summary_result = self._summarizer.generate(
                candidate_name=candidate_name,
                job_title=job_title,
                screening_type=screening.screening_type,
                questions_and_evaluations=qa_for_summary,
                aggregate_scores={
                    "overall": scores.overall_score,
                    "technical": scores.technical_score,
                    "communication": scores.communication_score,
                    "confidence": scores.confidence_score,
                },
            )

            total_prompt_tokens += summary_result.prompt_tokens
            total_completion_tokens += summary_result.completion_tokens

            # Build the AI summary text
            ai_summary_parts = [summary_result.overall_assessment]
            if summary_result.key_strengths:
                ai_summary_parts.append("Key strengths: " + "; ".join(summary_result.key_strengths))
            if summary_result.key_concerns:
                ai_summary_parts.append("Concerns: " + "; ".join(summary_result.key_concerns))
            if summary_result.follow_up_focus_areas:
                ai_summary_parts.append(
                    "Suggested interview focus: " + "; ".join(summary_result.follow_up_focus_areas)
                )

            # Persist aggregate results
            screening.status = "completed"
            screening.overall_score = scores.overall_score
            screening.communication_score = scores.communication_score
            screening.technical_score = scores.technical_score
            screening.confidence_score = scores.confidence_score
            screening.recommendation = scores.recommendation
            screening.ai_summary = "\n\n".join(ai_summary_parts)
            screening.completed_at = datetime.now(UTC)
            screening.prompt_tokens_used = (screening.prompt_tokens_used or 0) + total_prompt_tokens
            screening.completion_tokens_used = (screening.completion_tokens_used or 0) + total_completion_tokens
            self.db.add(screening)
            self.db.commit()

            logger.info(
                "screening.evaluation_completed screening_id=%s score=%.1f recommendation=%s",
                screening_id, scores.overall_score, scores.recommendation,
            )

        except Exception as exc:
            logger.exception("screening.run_evaluation.failed screening_id=%s: %s", screening_id, exc)
            try:
                s = self.db.get(AIScreening, screening_id)
                if s:
                    s.status = "failed"
                    self.db.add(s)
                    self.db.commit()
            except Exception:
                pass

    # ── Recruiter decision ────────────────────────────────────────────────────

    def record_recruiter_decision(
        self,
        org_id: UUID,
        screening_id: UUID,
        decision: str,
        notes: str | None,
    ) -> AIScreening:
        screening = self.get_screening(org_id, screening_id)
        screening.recruiter_decision = decision
        screening.recruiter_notes = notes
        self.db.add(screening)
        self.db.commit()
        self.db.refresh(screening)
        return screening

    # ── Delete ────────────────────────────────────────────────────────────────

    def delete_screening(self, org_id: UUID, screening_id: UUID) -> None:
        screening = self.get_screening(org_id, screening_id)
        self.db.delete(screening)
        self.db.commit()

    # =========================================================================
    # LIVE INTERVIEW MODE
    # Extends AIScreening with interview_mode='live', session_token, and
    # ai_screening_messages conversation history. The Groq client drives
    # dynamic question generation; AssemblyAI STT feeds transcripts from
    # the frontend; Web Speech API plays AI questions aloud in the browser.
    # =========================================================================

    def create_live_interview(
        self,
        org_id: UUID,
        current_user: CurrentUser,
        candidate_id: UUID,
        job_id: UUID | None = None,
        max_questions: int = 12,
        interview_duration_minutes: int = 20,
        expires_at: "datetime | None" = None,
        custom_instructions: str | None = None,
        invitation_email: str | None = None,
    ) -> AIScreening:
        """Create a live-interview screening session with a candidate join token."""
        import secrets
        from app.models.candidate import Candidate
        from app.models.job import Job

        candidate = self.db.get(Candidate, candidate_id)
        job = self.db.get(Job, job_id) if job_id else None

        candidate_name = (
            f"{candidate.first_name} {candidate.last_name}" if candidate else "Candidate"
        )
        job_title = job.title if job else "Unknown Role"

        session_token = secrets.token_urlsafe(32)
        livekit_room = f"screening-{secrets.token_hex(8)}"

        screening = AIScreening(
            organization_id=org_id,
            candidate_id=candidate_id,
            job_id=job_id,
            created_by=UUID(current_user.user_id),
            status="pending",
            screening_type="live_interview",
            interview_mode="live",
            session_token=session_token,
            max_questions=max_questions,
            interview_duration_minutes=interview_duration_minutes,
            expires_at=expires_at,
            custom_instructions=custom_instructions,
            invitation_email=invitation_email,
            livekit_room_name=livekit_room,
            candidate_name_snapshot=candidate_name,
            job_title_snapshot=job_title,
        )
        self.db.add(screening)
        self.db.commit()
        self.db.refresh(screening)
        logger.info(
            "live_interview.session_created id=%s candidate=%s token=%s",
            screening.id, candidate_name, session_token[:8] + "…",
        )
        return screening

    def get_screening_by_token(self, token: str) -> AIScreening | None:
        """Look up a live interview session by its candidate join token.

        Returns None when the token does not exist OR the invite has expired.
        Expired means expires_at is set and is in the past.
        """
        screening = self.db.scalar(
            select(AIScreening).where(AIScreening.session_token == token)
        )
        if screening is None:
            return None
        # Enforce expiry — completed interviews are still viewable
        if (
            screening.expires_at is not None
            and screening.status not in ("completed", "in_progress")
        ):
            now = datetime.now(UTC)
            if screening.expires_at < now:
                logger.info(
                    "ai_screening.token_expired screening=%s expires_at=%s",
                    screening.id, screening.expires_at.isoformat(),
                )
                return None
        return screening

    def send_invite(
        self,
        org_id: UUID,
        current_user: "CurrentUser",
        candidate_id: UUID,
        job_id: UUID | None,
        *,
        expires_at: "datetime | None" = None,
        max_questions: int = 12,
        interview_duration_minutes: int = 20,
        custom_instructions: str | None = None,
        pipeline_id: UUID | None = None,
    ) -> AIScreening:
        """Create a live interview session and email the candidate the invite link.

        Idempotent — if a pending/in_progress session already exists for this
        candidate × job pair we reuse it and re-send the email.
        """
        from app.models.candidate import Candidate
        from app.models.job import Job
        from app.services.ai_screening_email import send_ai_screening_invite

        candidate = self.db.get(Candidate, candidate_id)
        if candidate is None:
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="Candidate not found")

        job = self.db.get(Job, job_id) if job_id else None
        candidate_email = candidate.email
        if not candidate_email:
            from fastapi import HTTPException
            raise HTTPException(status_code=422, detail="Candidate has no email address")

        candidate_name = f"{candidate.first_name} {candidate.last_name}"
        job_title = job.title if job else "Unknown Role"

        # Reuse existing pending/not-started session if present
        existing = self.db.scalar(
            select(AIScreening).where(
                AIScreening.candidate_id == candidate_id,
                AIScreening.organization_id == org_id,
                AIScreening.interview_mode == "live",
                AIScreening.status.in_(["pending", "in_progress"]),
            ).order_by(AIScreening.created_at.desc())
        )

        if existing:
            screening = existing
            # Refresh expiry / config if recruiter resends
            screening.expires_at = expires_at
            screening.max_questions = max_questions
            screening.interview_duration_minutes = interview_duration_minutes
            screening.custom_instructions = custom_instructions
            self.db.add(screening)
        else:
            screening = self.create_live_interview(
                org_id=org_id,
                current_user=current_user,
                candidate_id=candidate_id,
                job_id=job_id,
                max_questions=max_questions,
                interview_duration_minutes=interview_duration_minutes,
                expires_at=expires_at,
                custom_instructions=custom_instructions,
                invitation_email=candidate_email,
            )
            if pipeline_id:
                screening.pipeline_id = pipeline_id

        # Send the email
        try:
            send_ai_screening_invite(
                to_email=candidate_email,
                candidate_name=candidate_name,
                job_title=job_title,
                token=screening.session_token,
                duration_minutes=interview_duration_minutes,
                expires_at=expires_at,
            )
            screening.invitation_sent_at = datetime.now(UTC)
            screening.invitation_email = candidate_email
        except Exception as exc:
            logger.error(
                "ai_screening.invite_email_failed candidate=%s job=%s: %s",
                candidate_id, job_id, exc,
            )
            # Don't block — session still created, recruiter can copy link manually
        finally:
            self.db.add(screening)
            self.db.commit()
            self.db.refresh(screening)

        logger.info(
            "ai_screening.invite_sent screening=%s candidate=%s email=%s",
            screening.id, candidate_name, candidate_email,
        )
        return screening

    def start_live_session(self, screening_id: UUID, org_id: UUID) -> tuple[AIScreening, str]:
        """Mark session in_progress, persist and return the opening question."""
        from app.models.ai_screening import AIScreeningMessage

        screening = self.get_screening(org_id, screening_id)
        now = datetime.now(UTC)

        # Generate first question
        opening = _OPENING_QUESTION

        # Persist as message #1
        msg = AIScreeningMessage(
            screening_id=screening_id,
            role="interviewer",
            content=opening,
            sequence_number=1,
            question_number=1,
            is_followup=False,
        )
        self.db.add(msg)

        screening.status = "in_progress"
        screening.started_at = now
        self.db.add(screening)
        self.db.commit()
        return screening, opening

    def process_live_turn(
        self,
        screening_id: UUID,
        org_id: UUID,
        transcript: str,
        raw_transcript: str | None = None,
        confidence: float | None = None,
    ) -> tuple[str | None, bool]:
        """Record candidate answer, generate and persist next AI question.

        Returns (next_question_text, should_end).
        Returns (None, True) when the interview should stop.
        """
        from sqlalchemy import func as sa_func
        from app.models.ai_screening import AIScreeningMessage
        from app.services.groq_interview_client import (
            GroqInterviewClient,
            GroqInterviewUnavailableError,
        )

        screening = self.get_screening(org_id, screening_id)
        if screening.status != "in_progress":
            return None, True
        if not is_substantive_answer(transcript):
            logger.info(
                "live_interview.answer_rejected id=%s reason=insufficient_content chars=%d",
                screening_id,
                len((transcript or "").strip()),
            )
            return "", False

        # Current question count (interviewer messages)
        q_count = self.db.scalar(
            select(sa_func.count()).select_from(AIScreeningMessage).where(
                AIScreeningMessage.screening_id == screening_id,
                AIScreeningMessage.role == "interviewer",
            )
        ) or 0

        max_seq = self.db.scalar(
            select(sa_func.max(AIScreeningMessage.sequence_number)).where(
                AIScreeningMessage.screening_id == screening_id
            )
        ) or 0

        # Save candidate answer
        self.db.add(AIScreeningMessage(
            screening_id=screening_id,
            role="candidate",
            content=transcript,
            sequence_number=max_seq + 1,
            question_number=q_count,
            is_followup=False,
            raw_transcript=raw_transcript,
            transcript_confidence=confidence,
        ))
        self.db.flush()
        logger.warning(
            "Answer saved id=%s q=%d words=%d",
            screening_id,
            q_count,
            len([w for w in transcript.split() if w.strip()]),
        )

        # ── Phase determination ───────────────────────────────────────────────
        # Assessment phase:  q_count < max_q           → Groq-generated questions
        # Logistics phase:   max_q ≤ q_count < max_q+N → mandatory fixed questions
        # End:               q_count >= max_q + N       → interview complete
        #
        # _auto_end_heuristic only applies during assessment (prevents it from
        # cutting off a candidate mid-logistics when they say "thank you").

        max_q = (screening.max_questions or 12)

        if q_count < max_q:
            # ── Assessment phase ──────────────────────────────────────────────
            if _auto_end_heuristic(transcript, q_count):
                # Candidate signalled they want to wrap up — skip remaining
                # assessment questions but still ask logistics questions.
                # Jump straight to the first logistics question.
                next_q = _LOGISTICS_QUESTIONS[0]
                new_q_num = max_q + 1  # logistics start here
                self.db.add(AIScreeningMessage(
                    screening_id=screening_id,
                    role="interviewer",
                    content=next_q,
                    sequence_number=max_seq + 2,
                    question_number=new_q_num,
                    is_followup=False,
                ))
                self.db.add(screening)
                self.db.commit()
                return next_q, False

            # Generate next assessment question via Groq
            history = self._live_conversation_history(screening_id)
            context = (
                f"\n\n[CONTEXT: Interviewing {screening.candidate_name_snapshot or 'candidate'}"
                f" for {screening.job_title_snapshot or 'a role'}. "
                f"Recruiter-style questions only — NO technical/coding questions.]"
            ) if q_count <= 2 else ""

            messages = [
                {"role": "system", "content": _LIVE_SYSTEM_PROMPT + context},
                *history,
            ]

            groq = GroqInterviewClient()
            try:
                resp = groq.chat(messages, temperature=0.75, max_tokens=200)
                next_q = resp.content.strip().strip('"').strip("'")
                screening.prompt_tokens_used = (screening.prompt_tokens_used or 0) + resp.prompt_tokens
                screening.completion_tokens_used = (screening.completion_tokens_used or 0) + resp.completion_tokens
            except GroqInterviewUnavailableError as exc:
                logger.warning("live_interview.groq_failed id=%s: %s", screening_id, exc)
                next_q = _fallback_question(q_count)

            new_q_num = q_count + 1

        elif q_count < max_q + _N_LOGISTICS:
            # ── Logistics phase ───────────────────────────────────────────────
            # q_count is the number of interviewer messages asked so far.
            # The next logistics question to ask has index: q_count - max_q
            #   q_count = max_q     → ask _LOGISTICS_QUESTIONS[0]  (notice period)
            #   q_count = max_q + 1 → ask _LOGISTICS_QUESTIONS[1]  (compensation)
            #   q_count = max_q + 2 → ask _LOGISTICS_QUESTIONS[2]  (candidate Qs)
            #   q_count = max_q + 3 → all answered → end
            logistics_idx = q_count - max_q   # which logistics question to ask next
            if logistics_idx < _N_LOGISTICS:
                next_q = _LOGISTICS_QUESTIONS[logistics_idx]
                new_q_num = max_q + logistics_idx + 1
                logger.info(
                    "live_interview.logistics_question id=%s idx=%d q_num=%d",
                    screening_id, logistics_idx, new_q_num,
                )
            else:
                # All logistics questions answered — end interview
                self.db.commit()
                return None, True

        elif q_count < max_q + _N_LOGISTICS + _CANDIDATE_QA_MAX_ROUNDS:
            # ── Candidate Q&A phase ───────────────────────────────────────────
            # The candidate just answered the "Do you have questions?" logistics
            # question OR asked a follow-up in this phase.
            # q_count == max_q + _N_LOGISTICS           → first candidate question received
            # q_count == max_q + _N_LOGISTICS + 1 → second exchange
            qa_round = q_count - (max_q + _N_LOGISTICS)  # 0-based

            # Check if the candidate is done (said no questions / farewell)
            no_more = _is_no_questions(transcript)
            if no_more:
                # Candidate declined — close immediately
                next_q = _CANDIDATE_QA_CLOSING
                new_q_num = q_count + 1
                self.db.add(AIScreeningMessage(
                    screening_id=screening_id,
                    role="interviewer",
                    content=next_q,
                    sequence_number=max_seq + 2,
                    question_number=new_q_num,
                    is_followup=False,
                ))
                self.db.add(screening)
                self.db.commit()
                # Return the closing message then end
                return next_q, True   # True = will end after this message is sent

            if qa_round + 1 >= _CANDIDATE_QA_MAX_ROUNDS:
                # Rounds exhausted — answer this one then close
                answer = _answer_candidate_question(screening, transcript, self.db)
                closing = f"{answer}\n\n{_CANDIDATE_QA_CLOSING}"
                new_q_num = q_count + 1
                self.db.add(AIScreeningMessage(
                    screening_id=screening_id,
                    role="interviewer",
                    content=closing,
                    sequence_number=max_seq + 2,
                    question_number=new_q_num,
                    is_followup=False,
                ))
                self.db.add(screening)
                self.db.commit()
                return closing, True  # end after sending

            # Rounds remaining — answer and invite follow-up
            next_q = _answer_candidate_question(screening, transcript, self.db)
            new_q_num = q_count + 1

        else:
            # Past all phases — end interview
            self.db.commit()
            return None, True

        # new_q_num is already set in the appropriate branch above — do NOT override it.
        self.db.add(AIScreeningMessage(
            screening_id=screening_id,
            role="interviewer",
            content=next_q,
            sequence_number=max_seq + 2,
            question_number=new_q_num,
            is_followup=False,   # logistics questions are never follow-ups
        ))
        self.db.add(screening)
        self.db.commit()

        logger.info("live_interview.question_generated id=%s q=%d", screening_id, new_q_num)
        return next_q, False

    def end_live_interview(self, screening_id: UUID, org_id: UUID) -> AIScreening:
        """End the live interview session and generate assessment.

        Pipeline advancement is intentionally NOT performed here.
        The candidate stays in the ai_interview stage with status=review_pending
        until a recruiter explicitly reviews the results and makes a decision via
        submit_review_decision().
        """
        screening = self.get_screening(org_id, screening_id)
        now = datetime.now(UTC)

        if screening.started_at:
            screening.duration_seconds = int((now - screening.started_at).total_seconds())

        # Mark as completed so the assessment generator can run, then flip to
        # review_pending so the recruiter sees it as awaiting their review.
        screening.status = "completed"
        screening.ended_at = now
        self.db.add(screening)
        self.db.commit()

        try:
            self._generate_live_assessment(screening_id, org_id)
        except Exception as exc:
            logger.exception("live_interview.assessment_failed id=%s: %s", screening_id, exc)

        self.db.refresh(screening)

        # Flip to review_pending (leave incomplete/failed statuses alone — those
        # signal a problem and should not silently become review_pending).
        if screening.status == "completed":
            screening.status = "review_pending"
            self.db.add(screening)
            self.db.commit()
            self.db.refresh(screening)
            logger.info(
                "live_interview.awaiting_review id=%s recommendation=%s",
                screening_id, screening.recommendation,
            )

        return screening

    def submit_review_decision(
        self,
        org_id: UUID,
        screening_id: UUID,
        decision: str,     # "advance" | "reject" | "hold"
        notes: str | None,
    ) -> AIScreening:
        """Recruiter makes a final decision on a completed AI screening.

        advance → moves the candidate pipeline to the interview stage
        reject  → moves the candidate pipeline to rejected
        hold    → leaves the candidate in ai_interview, records the decision

        In all cases the screening status is set to "completed" and the
        recruiter decision + notes are persisted.
        """
        screening = self.get_screening(org_id, screening_id)

        if screening.status not in ("review_pending", "incomplete"):
            from fastapi import HTTPException
            raise HTTPException(
                status_code=400,
                detail=f"Cannot submit review decision for screening with status='{screening.status}'. "
                       "Only review_pending or incomplete screenings can be decided.",
            )

        screening.recruiter_decision = decision
        screening.recruiter_notes = notes
        screening.status = "completed"
        self.db.add(screening)
        self.db.commit()

        if decision in ("advance", "reject") and screening.job_id:
            try:
                self.advance_pipeline_from_screening(
                    org_id=org_id,
                    candidate_id=screening.candidate_id,
                    job_id=screening.job_id,
                    recommendation=decision,   # "advance" → interview, "reject" → rejected
                )
            except Exception:
                logger.warning(
                    "submit_review_decision.pipeline_move_failed id=%s decision=%s",
                    screening_id, decision, exc_info=True,
                )

        self.db.refresh(screening)
        logger.info(
            "live_interview.review_submitted id=%s decision=%s",
            screening_id, decision,
        )
        return screening

    def get_live_messages(self, screening_id: UUID) -> list:
        """Return ordered conversation messages for a live interview."""
        from app.models.ai_screening import AIScreeningMessage
        return list(
            self.db.scalars(
                select(AIScreeningMessage)
                .where(AIScreeningMessage.screening_id == screening_id)
                .order_by(AIScreeningMessage.sequence_number)
            )
        )

    # ── Private helpers ───────────────────────────────────────────────────────

    def _live_conversation_history(self, screening_id: UUID) -> list[dict]:
        from app.models.ai_screening import AIScreeningMessage
        msgs = list(
            self.db.scalars(
                select(AIScreeningMessage)
                .where(AIScreeningMessage.screening_id == screening_id)
                .order_by(AIScreeningMessage.sequence_number)
            )
        )
        history: list[dict] = []
        for m in msgs:
            role = "assistant" if m.role == "interviewer" else "user"
            history.append({"role": role, "content": m.content})
        return history[-20:]  # keep last 20 turns within token budget

    def _generate_live_assessment(self, screening_id: UUID, org_id: UUID) -> None:
        """Generate structured evaluation from the full transcript via Groq.

        COMPLETENESS GATE: if the interview did not meet minimum thresholds
        (answered questions, word count, duration) the screening is marked
        'incomplete' and NO scores or recommendation are written.  Groq is
        never called with insufficient data, preventing hallucinated scores.
        """
        from app.services.groq_interview_client import GroqInterviewClient

        screening = self.get_screening(org_id, screening_id)
        msgs = self.get_live_messages(screening_id)
        max_q = screening.max_questions or 12

        # ── Separate assessment messages from logistics messages ──────────────
        # Logistics messages have question_number > max_q.
        # Only assessment messages contribute to AI scoring.
        all_candidate_msgs   = [m for m in msgs if m.role == "candidate"]
        all_interviewer_msgs = [m for m in msgs if m.role == "interviewer"]

        assessment_candidate   = [m for m in all_candidate_msgs
                                   if (m.question_number or 0) <= max_q]
        assessment_interviewer = [m for m in all_interviewer_msgs
                                   if (m.question_number or 0) <= max_q]
        logistics_candidate    = [m for m in all_candidate_msgs
                                   if (m.question_number or 0) > max_q]

        # ── Extract logistics answers ─────────────────────────────────────────
        # Store directly on the screening row so they surface in the recruiter UI.
        # These are verbatim candidate answers, not AI-generated.
        if len(logistics_candidate) >= 1:
            screening.notice_period = logistics_candidate[0].content
        if len(logistics_candidate) >= 2:
            screening.salary_expectation = logistics_candidate[1].content
        if len(logistics_candidate) >= 3:
            screening.candidate_questions = logistics_candidate[2].content

        logger.info(
            "live_interview.logistics_extracted id=%s notice=%s salary=%s cand_qs=%s",
            screening_id,
            bool(screening.notice_period),
            bool(screening.salary_expectation),
            bool(screening.candidate_questions),
        )

        # ── Compute assessment-only metrics (used for completeness gates) ─────
        candidate_msgs   = assessment_candidate
        interviewer_msgs = assessment_interviewer

        q_asked    = len(interviewer_msgs)
        q_answered = len(candidate_msgs)

        candidate_text   = " ".join(m.content for m in candidate_msgs)
        candidate_words  = len(candidate_text.split()) if candidate_text.strip() else 0
        transcript_chars = len(candidate_text.strip())
        duration_secs    = screening.duration_seconds or 0

        metrics = {
            "questions_asked":    q_asked,
            "questions_answered": q_answered,
            "candidate_words":    candidate_words,
            "transcript_chars":   transcript_chars,
            "duration_seconds":   duration_secs,
            "scoring_eligible":   False,  # set to True below if thresholds met
        }

        logger.info(
            "live_interview.completeness_check id=%s q_asked=%d q_answered=%d "
            "words=%d duration=%ds (assessment only, logistics excluded)",
            screening_id, q_asked, q_answered, candidate_words, duration_secs,
        )

        # ── Hard gates (truly insufficient data) ─────────────────────────────
        # Only question coverage and word count block scoring.
        # Duration is a soft signal — a candidate who answered all questions
        # with sufficient detail should receive a score even if the interview
        # ended slightly early.

        min_answers_required = max(1, int(q_asked * _MIN_ANSWER_COVERAGE)) if q_asked > 0 else 1
        hard_fails = []

        if q_answered < min_answers_required:
            hard_fails.append(
                f"only {q_answered} of {min_answers_required} required questions answered "
                f"({int(_MIN_ANSWER_COVERAGE * 100)}% of {q_asked} asked)"
            )
        if candidate_words < _MIN_CANDIDATE_WORDS:
            hard_fails.append(
                f"only {candidate_words} words spoken ({_MIN_CANDIDATE_WORDS} required)"
            )

        if hard_fails:
            reason_text = "; ".join(hard_fails)
            screening.status            = "incomplete"
            screening.incomplete_reason = f"Interview incomplete — {reason_text}"
            screening.overall_score       = None
            screening.communication_score = None
            screening.experience_score    = None
            screening.confidence_score    = None
            screening.culture_fit_score   = None
            screening.leadership_score    = None
            screening.recommendation      = None
            screening.strengths           = []
            screening.concerns            = []
            screening.ai_summary = (
                f"Interview incomplete — insufficient response data. "
                f"Reason: {reason_text}. "
                f"Questions answered: {q_answered}/{min_answers_required}. "
                f"Words spoken: {candidate_words}/{_MIN_CANDIDATE_WORDS}."
            )
            self.db.add(screening)
            self.db.commit()
            logger.warning("live_interview.incomplete id=%s reason=%s", screening_id, reason_text)
            return

        # ── Soft duration check ───────────────────────────────────────────────
        # Duration below the recommended threshold reduces confidence but does
        # not block scoring.  The warning is included in the Groq context so
        # the model can calibrate its output, and stored in incomplete_reason
        # so the recruiter review page can surface it as a warning badge.
        short_duration = duration_secs > 0 and duration_secs < _RECOMMENDED_DURATION_SECS
        duration_warning = (
            f"Interview completed with shorter-than-recommended duration "
            f"({duration_secs}s; recommended {_RECOMMENDED_DURATION_SECS}s). "
            f"Scores generated with reduced confidence."
            if short_duration else ""
        )

        if short_duration:
            screening.incomplete_reason = duration_warning
            logger.info(
                "live_interview.short_duration id=%s duration=%ds — scoring with reduced confidence",
                screening_id, duration_secs,
            )

        metrics["scoring_eligible"] = True
        logger.info("live_interview.scoring_eligible id=%s metrics=%s", screening_id, metrics)

        # ── Build ASSESSMENT-ONLY transcript for Groq ────────────────────────
        # Logistics messages (notice period, compensation, candidate questions)
        # are excluded — they are verbatim data and must not dilute the scores.
        assessment_msgs = [
            m for m in msgs
            if (m.question_number or 0) <= max_q
        ]
        transcript_lines = "\n\n".join(
            f"{'Interviewer' if m.role == 'interviewer' else 'Candidate'}: {m.content}"
            for m in assessment_msgs
        )
        job_ctx = (
            f"Role: {screening.job_title_snapshot or 'Not specified'}\n"
            f"Candidate: {screening.candidate_name_snapshot or 'Unknown'}\n"
            f"Questions asked: {q_asked} | Candidate answers: {q_answered} | "
            f"Candidate words: {candidate_words} | Duration: {duration_secs}s\n"
            + (f"NOTE: {duration_warning}\n" if duration_warning else "")
            + "\n"
        )

        groq_messages = [
            {"role": "system", "content": _ASSESSMENT_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"{job_ctx}"
                    f"Full interview transcript:\n\n{transcript_lines}"
                ),
            },
        ]

        # ── Call Groq ─────────────────────────────────────────────────────────
        groq = GroqInterviewClient()
        try:
            resp = groq.chat_json(groq_messages, temperature=0.1, max_tokens=2000)
            data = resp.parse_json()
        except Exception as exc:
            logger.error("live_interview.assessment_parse_failed id=%s: %s", screening_id, exc)
            # Do NOT write a fabricated recommendation — mark as failed
            screening.status = "failed"
            screening.ai_summary = "Automated assessment failed. Please review the transcript manually."
            self.db.add(screening)
            self.db.commit()
            return

        def _score(v: object) -> float | None:
            try:
                return max(0.0, min(100.0, float(v)))  # type: ignore[arg-type]
            except (TypeError, ValueError):
                return None

        def _parse_evidence_list(raw: object) -> list[str]:
            """Convert [{claim, evidence}] or [str] into 'claim — Evidence: evidence' strings."""
            if not isinstance(raw, list):
                return []
            out: list[str] = []
            for item in raw:
                if isinstance(item, dict):
                    claim    = str(item.get("claim", "")).strip()
                    evidence = str(item.get("evidence", "")).strip()
                    if claim:
                        out.append(f"{claim} — Evidence: \"{evidence}\"" if evidence else claim)
                elif isinstance(item, str) and item.strip():
                    out.append(item.strip())
            return out

        screening.communication_score    = _score(data.get("communication_score"))
        screening.experience_score       = _score(data.get("experience_score"))
        screening.confidence_score       = _score(data.get("confidence_score"))
        screening.culture_fit_score      = _score(data.get("culture_fit_score"))
        screening.leadership_score       = _score(data.get("leadership_score"))
        screening.overall_score          = _score(data.get("overall_score"))
        screening.recommendation         = data.get("recommendation") or "consider"
        screening.strengths              = _parse_evidence_list(data.get("strengths"))
        screening.concerns               = _parse_evidence_list(data.get("concerns"))
        screening.salary_expectation     = data.get("salary_expectation")
        screening.notice_period          = data.get("notice_period")
        screening.career_goals           = data.get("career_goals")
        screening.key_projects_mentioned = (
            [p for p in data.get("key_projects_mentioned", []) if isinstance(p, str)]
        )
        screening.ai_summary             = data.get("ai_summary")
        screening.prompt_tokens_used     = (screening.prompt_tokens_used or 0) + resp.prompt_tokens
        screening.completion_tokens_used = (screening.completion_tokens_used or 0) + resp.completion_tokens

        self.db.add(screening)
        self.db.commit()
        logger.info(
            "live_interview.assessment_complete id=%s q_answered=%d words=%d "
            "score=%.1f rec=%s",
            screening_id, q_answered, candidate_words,
            screening.overall_score or 0, screening.recommendation,
        )


# ── Helpers ───────────────────────────────────────────────────────────────────


    # =========================================================================
    # PIPELINE-INTEGRATED SCREENING
    # Candidates in the 'ai_interview' pipeline stage are the source of truth.
    # =========================================================================

    def get_pipeline_screening_queue(
        self,
        org_id,
        *,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        """Pipeline entries in 'ai_interview' stage + their AI interview status."""
        from app.models.pipeline import Pipeline

        stmt = (
            select(
                Pipeline.id.label("pipeline_id"),
                Pipeline.candidate_id,
                Pipeline.job_id,
                Pipeline.stage,
                Pipeline.status.label("pipeline_status"),
                Pipeline.stage_updated_at,
                Candidate.first_name,
                Candidate.last_name,
                Candidate.email,
                Job.title.label("job_title"),
                Job.client_id,
                AIScreening.id.label("screening_id"),
                AIScreening.status.label("screening_status"),
                AIScreening.overall_score,
                AIScreening.recommendation,
                AIScreening.session_token,
                AIScreening.interview_mode,
                AIScreening.started_at,
                AIScreening.ended_at,
                AIScreening.incomplete_reason,
                AIScreening.duration_seconds,
            )
            .select_from(Pipeline)
            .join(Candidate, Candidate.id == Pipeline.candidate_id)
            .join(Job, Job.id == Pipeline.job_id)
            .outerjoin(
                AIScreening,
                (AIScreening.candidate_id == Pipeline.candidate_id)
                & (AIScreening.job_id == Pipeline.job_id)
                & (AIScreening.interview_mode == "live"),
            )
            .where(
                Pipeline.organization_id == org_id,
                Pipeline.stage == "ai_interview",
                Pipeline.status.not_in(["withdrawn", "closed"]),
            )
            .order_by(Pipeline.stage_updated_at.desc())
            .limit(limit)
            .offset(offset)
        )

        rows = self.db.execute(stmt).mappings().all()
        result = []
        for r in rows:
            client_name = None
            if r["client_id"]:
                from app.models.client import Client
                client = self.db.get(Client, r["client_id"])
                client_name = client.name if client else None

            result.append({
                "pipeline_id": str(r["pipeline_id"]),
                "candidate_id": str(r["candidate_id"]),
                "job_id": str(r["job_id"]) if r["job_id"] else None,
                "pipeline_stage": r["stage"],
                "pipeline_status": r["pipeline_status"],
                "stage_updated_at": r["stage_updated_at"].isoformat() if r["stage_updated_at"] else None,
                "candidate_name": f"{r['first_name']} {r['last_name']}",
                "candidate_email": r["email"],
                "job_title": r["job_title"],
                "client_name": client_name,
                "screening_id": str(r["screening_id"]) if r["screening_id"] else None,
                "interview_status": r["screening_status"] or "not_started",
                "overall_score": float(r["overall_score"]) if r["overall_score"] is not None else None,
                "recommendation": r["recommendation"],
                "session_token": r["session_token"],
                "interview_mode": r["interview_mode"],
                "started_at": r["started_at"].isoformat() if r["started_at"] else None,
                "ended_at": r["ended_at"].isoformat() if r["ended_at"] else None,
                "incomplete_reason": r["incomplete_reason"],
                "duration_seconds": r["duration_seconds"],
            })
        return result

    def auto_create_for_pipeline(
        self,
        org_id,
        candidate_id,
        job_id,
        pipeline_id,
        created_by=None,
    ):
        """Auto-create a live screening when candidate enters screening stage. Idempotent."""
        import secrets as _secrets

        existing = self.db.scalar(
            select(AIScreening).where(
                AIScreening.candidate_id == candidate_id,
                AIScreening.job_id == job_id,
                AIScreening.interview_mode == "live",
            )
        )
        if existing:
            logger.info("ai_screening.auto_create.exists id=%s", existing.id)
            return existing

        candidate = self.db.get(Candidate, candidate_id)
        job = self.db.get(Job, job_id)
        candidate_name = f"{candidate.first_name} {candidate.last_name}" if candidate else "Candidate"
        job_title = job.title if job else "Unknown Role"

        screening = AIScreening(
            organization_id=org_id,
            candidate_id=candidate_id,
            job_id=job_id,
            pipeline_id=pipeline_id,
            created_by=created_by,
            status="pending",
            screening_type="live_interview",
            interview_mode="live",
            session_token=_secrets.token_urlsafe(32),
            livekit_room_name=f"screening-{_secrets.token_hex(8)}",
            candidate_name_snapshot=candidate_name,
            job_title_snapshot=job_title,
        )
        self.db.add(screening)
        self.db.commit()
        self.db.refresh(screening)
        logger.info("ai_screening.auto_created id=%s candidate=%s", screening.id, candidate_name)
        return screening

    def get_or_create_for_candidate(self, org_id, candidate_id):
        """Get or auto-create live screening for a candidate in AI interview stage."""
        from app.models.pipeline import Pipeline

        pipeline = self.db.scalar(
            select(Pipeline).where(
                Pipeline.organization_id == org_id,
                Pipeline.candidate_id == candidate_id,
                Pipeline.stage == "ai_interview",
            ).order_by(Pipeline.stage_updated_at.desc())
        )
        if not pipeline:
            return None

        existing = self.db.scalar(
            select(AIScreening).where(
                AIScreening.candidate_id == candidate_id,
                AIScreening.job_id == pipeline.job_id,
                AIScreening.interview_mode == "live",
            )
        )
        if existing:
            return existing

        return self.auto_create_for_pipeline(
            org_id=org_id,
            candidate_id=candidate_id,
            job_id=pipeline.job_id,
            pipeline_id=pipeline.id,
        )

    def advance_pipeline_from_screening(self, org_id, candidate_id, job_id, recommendation):
        """Move the candidate's pipeline entry after a recruiter decision.

        recommendation values accepted:
          "advance" | anything except "reject"  → interview stage
          "reject"                               → rejected
        """
        from app.models.pipeline import Pipeline
        from datetime import UTC, datetime

        pipeline = self.db.scalar(
            select(Pipeline).where(
                Pipeline.organization_id == org_id,
                Pipeline.candidate_id == candidate_id,
                Pipeline.job_id == job_id,
                Pipeline.stage == "ai_interview",
            )
        )
        if not pipeline:
            logger.warning("ai_screening.advance.not_found candidate=%s", candidate_id)
            return

        new_stage = "rejected" if recommendation == "reject" else "interview"
        pipeline.stage = new_stage
        pipeline.stage_updated_at = datetime.now(UTC)
        if new_stage == "rejected":
            pipeline.status = "closed"

        self.db.add(pipeline)
        self.db.commit()
        logger.info("ai_screening.pipeline_advanced candidate=%s ->%s", candidate_id, new_stage)


def _infer_seniority(candidate: Candidate | None) -> str:
    if not candidate:
        return "mid-level"
    years = getattr(candidate, "years_experience", None)
    if years is None:
        # Try parsed resume data
        parsed = getattr(candidate, "parsed_resume_data", None) or {}
        years = parsed.get("years_of_experience")
    if years is None:
        return "mid-level"
    try:
        years = float(years)
    except (TypeError, ValueError):
        return "mid-level"
    if years < 2:
        return "junior"
    elif years < 5:
        return "mid-level"
    elif years < 9:
        return "senior"
    else:
        return "lead/principal"

# ── Live interview prompts ────────────────────────────────────────────────────

_OPENING_QUESTION = (
    "Can you briefly introduce yourself and walk me through your professional background?"
)

# ── Mandatory recruiter logistics questions ───────────────────────────────────
# These are ALWAYS asked after the AI assessment questions, regardless of
# max_questions.  They are excluded from AI scoring — only assessed questions
# contribute to scores and recommendations.

_LOGISTICS_QUESTIONS: list[str] = [
    "Thank you — just a couple of quick practical questions for the hiring team. "
    "What is your current notice period, and when would you be available to start if you were offered this role?",

    "What are your current and expected compensation expectations? "
    "Please mention your current package and what you're looking for in your next role.",

    "Finally, do you have any questions for us about the role, the team, or the company? "
    "Feel free to ask anything that would help you decide.",
]

_N_LOGISTICS = len(_LOGISTICS_QUESTIONS)   # 3

# ── Candidate Q&A phase ───────────────────────────────────────────────────────
# After the final logistics question ("Do you have any questions?") the AI must
# genuinely RESPOND to whatever the candidate asks — not end the interview.
# Up to _CANDIDATE_QA_MAX_ROUNDS exchanges are allowed before the AI closes.

_CANDIDATE_QA_MAX_ROUNDS = 2   # max candidate question→AI answer rounds

_CANDIDATE_QA_SYSTEM_PROMPT = """\
You are the AI interviewer for {company} conducting a candidate Q&A.
The candidate just asked you a question about the role or company.

Context you have available:
{job_context}

Rules:
- Answer the candidate's question concisely and honestly using the context above.
- If you do not have specific information, say so warmly and suggest they ask the recruiter.
- Keep the response to 2–4 sentences maximum.
- After answering, invite follow-up: "Is there anything else you'd like to know?"
- Do NOT ask assessment questions — you are in the closing Q&A phase.
- Return ONLY your response — no preamble, labels, or system notes.
"""

_CANDIDATE_QA_CLOSING = (
    "Thank you so much for your time today — it was great speaking with you. "
    "The recruitment team will review your responses and be in touch soon. "
    "We wish you all the best!"
)

_LIVE_SYSTEM_PROMPT = """\
You are a senior recruitment specialist conducting an initial candidate screening interview.

Rules:
- Ask ONE question at a time — never multiple questions in a single message.
- Build follow-up questions from what the candidate actually says.
- Topics to cover: work experience, key projects, career goals, salary expectations, \
notice period, team fit, motivation, and role understanding.
- NEVER ask technical coding questions, algorithms, or whiteboard problems.
- Keep the tone warm, conversational, and professional.
- Return ONLY the question — no preamble, labels, or lists.
- One or two sentences maximum per question.

Routing rules:
- Candidate mentions a project → ask about their specific contribution and impact.
- Candidate mentions leadership → ask about team size and management approach.
- Candidate mentions career change → ask about motivation for the switch.
- Candidate mentions redundancy / layoff → ask sensitively about current situation.
- After 12+ questions → ask about notice period or salary if not yet covered.
"""

# ── Scoring thresholds ────────────────────────────────────────────────────────
# These are enforced in Python BEFORE calling Groq. The LLM never sees
# insufficient data — it cannot hallucinate scores for a partial transcript.

_MIN_CANDIDATE_WORDS       = 200   # total words across all candidate messages — hard gate
_MIN_ANSWER_COVERAGE       = 0.80  # candidate must answer ≥ 80% of questions asked — hard gate
_RECOMMENDED_DURATION_SECS = 300   # 5 min — below this a low-confidence warning is added but
                                   # scoring is NOT blocked; duration alone never fails an interview
_MIN_TURN_WORDS            = 3     # minimum words to treat one turn as a real answer
_MIN_TURN_CHARS            = 12    # avoid progressing on filler like "yes" / "ok"

_ASSESSMENT_SYSTEM_PROMPT = """\
You are an expert HR analytics engine evaluating a completed screening interview.

STRICT RULES — READ BEFORE SCORING:
1. Only score dimensions for which the transcript contains DIRECT EVIDENCE.
   If the transcript lacks evidence for a dimension, score it 40 (insufficient data).
2. Every strength and concern MUST include a direct quote or specific paraphrase
   from the transcript as evidence. No generic statements allowed.
3. DO NOT invent, assume, or extrapolate information not present in the transcript.
4. If the candidate gave vague or one-word answers, score them low (30–45).
5. Scores must reflect actual transcript content, not job-title assumptions.

OUTPUT FORMAT (return ONLY valid JSON, no prose, no markdown):
{
  "communication_score": <0-100 integer, based on clarity, fluency, structure>,
  "experience_score": <0-100 integer, based on concrete examples given>,
  "confidence_score": <0-100 integer, based on decisiveness and specificity>,
  "culture_fit_score": <0-100 integer, based on collaboration/values signals>,
  "leadership_score": <0-100 integer, based on evidence of leadership, team management, or initiative; score 40 if no evidence>,
  "overall_score": <0-100 integer, weighted composite>,
  "recommendation": "<strong_hire|hire|consider|reject>",
  "strengths": [
    {"claim": "<one-line strength>", "evidence": "<direct quote or paraphrase>"}
  ],
  "concerns": [
    {"claim": "<one-line concern>", "evidence": "<direct quote or paraphrase>"}
  ],
  "salary_expectation": "<exact text from transcript or null>",
  "notice_period": "<exact text from transcript or null>",
  "career_goals": "<verbatim or close paraphrase from transcript, or null>",
  "key_projects_mentioned": ["<only projects explicitly named by candidate>"],
  "ai_summary": "<3-4 sentence factual summary based strictly on transcript>"
}

SCORING THRESHOLDS:
  strong_hire: 85+  (clear strengths, strong evidence across multiple areas)
  hire:        70–84 (solid performance, good evidence)
  consider:    55–69 (mixed performance, some gaps)
  reject:      <55   (significant concerns, vague/weak answers)

EVIDENCE REQUIREMENT:
  - A strength with no direct transcript evidence MUST NOT be listed.
  - A concern with no direct transcript evidence MUST NOT be listed.
  - Generic phrases like "good communicator" without evidence → omit entirely.
"""


def _auto_end_heuristic(last_answer: str, q_count: int) -> bool:
    """Return True if the interview should wrap up automatically."""
    if q_count < 8:
        return False
    goodbyes = {"thank you", "thanks for having me", "goodbye", "that's all", "no more questions"}
    return any(phrase in last_answer.lower() for phrase in goodbyes)


def _fallback_question(q_num: int) -> str:
    """Generic follow-up when Groq is unavailable."""
    bank = [
        "Can you tell me about a project you are particularly proud of?",
        "What motivates you most in your day-to-day work?",
        "How do you handle sudden changes in priorities?",
        "Tell me about a time you worked closely with a difficult colleague.",
        "What are your career goals for the next two to three years?",
        "What is your current notice period, and what are your salary expectations?",
        "Why are you interested in this particular role?",
        "What questions do you have for us about the team or company?",
    ]
    return bank[min(q_num - 1, len(bank) - 1)]


def _is_no_questions(text: str) -> bool:
    """Return True when the candidate indicates they have no questions."""
    lowered = (text or "").lower().strip()
    no_patterns = [
        "no ", "nope", "not really", "nothing", "none",
        "i'm good", "i am good", "that's all", "that is all",
        "no questions", "no thank", "thank you, no",
    ]
    return any(lowered.startswith(p) or p in lowered[:80] for p in no_patterns)


def _answer_candidate_question(screening: "AIScreening", question: str, db: "Session") -> str:
    """Use Groq to answer the candidate's question using job description context."""
    from app.services.groq_interview_client import GroqInterviewClient, GroqInterviewUnavailableError
    from app.models.job import Job

    job_title = screening.job_title_snapshot or "Unknown Role"
    job_description = ""
    if screening.job_id:
        try:
            job = db.get(Job, screening.job_id)
            if job:
                job_description = (job.description or "")[:2000]
        except Exception:
            pass

    job_context = f"Role: {job_title}\n\nJob Description:\n{job_description}" if job_description \
        else f"Role: {job_title}"

    system_prompt = _CANDIDATE_QA_SYSTEM_PROMPT.format(
        company="the company",
        job_context=job_context,
    )

    groq = GroqInterviewClient()
    try:
        resp = groq.chat(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": question},
            ],
            temperature=0.5,
            max_tokens=300,
        )
        return resp.content.strip()
    except GroqInterviewUnavailableError:
        return (
            "That's a great question — the recruiting team will be able to provide "
            "you with full details when they follow up. Is there anything else you'd like to know?"
        )


def is_substantive_answer(text: str) -> bool:
    """Return True when the candidate answer has enough content to progress."""
    cleaned = (text or "").strip()
    if len(cleaned) < _MIN_TURN_CHARS:
        return False
    words = [w for w in cleaned.split() if w.strip()]
    return len(words) >= _MIN_TURN_WORDS
