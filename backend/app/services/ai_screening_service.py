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
        max_questions: int = 15,
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
        """Look up a live interview session by its candidate join token."""
        return self.db.scalar(
            select(AIScreening).where(AIScreening.session_token == token)
        )

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

        # Should we end?
        max_q = 15  # hard cap
        should_end = q_count >= max_q or _auto_end_heuristic(transcript, q_count)
        if should_end:
            self.db.commit()
            return None, True

        # Build conversation history for Groq
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
        self.db.add(AIScreeningMessage(
            screening_id=screening_id,
            role="interviewer",
            content=next_q,
            sequence_number=max_seq + 2,
            question_number=new_q_num,
            is_followup=True,
        ))
        self.db.add(screening)
        self.db.commit()

        logger.info("live_interview.question_generated id=%s q=%d", screening_id, new_q_num)
        return next_q, False

    def end_live_interview(self, screening_id: UUID, org_id: UUID) -> AIScreening:
        """End the live interview session, generate assessment, and auto-advance pipeline."""
        screening = self.get_screening(org_id, screening_id)
        now = datetime.now(UTC)

        if screening.started_at:
            screening.duration_seconds = int((now - screening.started_at).total_seconds())

        screening.status = "completed"
        screening.ended_at = now
        self.db.add(screening)
        self.db.commit()

        try:
            self._generate_live_assessment(screening_id, org_id)
        except Exception as exc:
            logger.exception("live_interview.assessment_failed id=%s: %s", screening_id, exc)

        self.db.refresh(screening)

        # Auto-advance the pipeline — only when the interview completed with a
        # valid recommendation (not incomplete, not failed, not empty)
        if (
            screening.status == "completed"
            and screening.recommendation
            and screening.job_id
        ):
            try:
                self.advance_pipeline_from_screening(
                    org_id=org_id,
                    candidate_id=screening.candidate_id,
                    job_id=screening.job_id,
                    recommendation=screening.recommendation,
                )
            except Exception:
                logger.warning(
                    "live_interview.pipeline_advance_failed id=%s — suppressed",
                    screening_id, exc_info=True,
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

        # ── Compute interview metrics ─────────────────────────────────────────
        candidate_msgs = [m for m in msgs if m.role == "candidate"]
        interviewer_msgs = [m for m in msgs if m.role == "interviewer"]

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
            "words=%d duration=%ds",
            screening_id, q_asked, q_answered, candidate_words, duration_secs,
        )

        # ── Completeness gate ─────────────────────────────────────────────────
        reasons = []
        if q_answered < _MIN_ANSWERED_QUESTIONS:
            reasons.append(
                f"only {q_answered} of {_MIN_ANSWERED_QUESTIONS} required questions answered"
            )
        if candidate_words < _MIN_CANDIDATE_WORDS:
            reasons.append(
                f"only {candidate_words} words spoken ({_MIN_CANDIDATE_WORDS} required)"
            )
        if duration_secs < _MIN_DURATION_SECONDS:
            reasons.append(
                f"interview lasted only {duration_secs}s ({_MIN_DURATION_SECONDS}s / 5 min required)"
            )

        if reasons:
            reason_text = "; ".join(reasons)
            screening.status            = "incomplete"
            screening.incomplete_reason = f"Interview incomplete — {reason_text}"
            # Explicitly clear any partial scores so nothing leaks through
            screening.overall_score       = None
            screening.communication_score = None
            screening.experience_score    = None
            screening.confidence_score    = None
            screening.culture_fit_score   = None
            screening.recommendation      = None
            screening.strengths           = []
            screening.concerns            = []
            screening.ai_summary          = (
                f"Interview incomplete — insufficient response data. "
                f"Reason: {reason_text}. "
                f"Questions answered: {q_answered}/{_MIN_ANSWERED_QUESTIONS}. "
                f"Words spoken: {candidate_words}/{_MIN_CANDIDATE_WORDS}. "
                f"Duration: {duration_secs}s/{_MIN_DURATION_SECONDS}s."
            )
            self.db.add(screening)
            self.db.commit()
            logger.warning(
                "live_interview.incomplete id=%s reason=%s",
                screening_id, reason_text,
            )
            return

        metrics["scoring_eligible"] = True
        logger.info("live_interview.scoring_eligible id=%s metrics=%s", screening_id, metrics)

        # ── Build transcript for Groq ─────────────────────────────────────────
        transcript_lines = "\n\n".join(
            f"{'Interviewer' if m.role == 'interviewer' else 'Candidate'}: {m.content}"
            for m in msgs
        )
        job_ctx = (
            f"Role: {screening.job_title_snapshot or 'Not specified'}\n"
            f"Candidate: {screening.candidate_name_snapshot or 'Unknown'}\n"
            f"Questions asked: {q_asked} | Candidate answers: {q_answered} | "
            f"Candidate words: {candidate_words} | Duration: {duration_secs}s\n\n"
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
        """After AI interview: advance to interview stage or reject."""
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

_MIN_ANSWERED_QUESTIONS = 5   # candidate must have responded at least 5 times
_MIN_CANDIDATE_WORDS    = 200  # total words across all candidate messages
_MIN_DURATION_SECONDS   = 300  # 5 minutes minimum interview duration
_MIN_TURN_WORDS         = 3    # minimum words required to treat an answer as real
_MIN_TURN_CHARS         = 12   # avoid progressing on filler like "yes" / "ok"

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


def is_substantive_answer(text: str) -> bool:
    """Return True when the candidate answer has enough content to progress."""
    cleaned = (text or "").strip()
    if len(cleaned) < _MIN_TURN_CHARS:
        return False
    words = [w for w in cleaned.split() if w.strip()]
    return len(words) >= _MIN_TURN_WORDS
