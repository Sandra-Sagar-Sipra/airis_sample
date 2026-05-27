"""AI-004: Interview summary generation service.

Generates a structured post-interview summary using the OpenAI provider.
Output format (AI-004 spec):
  {
    "key_strengths":      ["..."],        # 3-5 items
    "concerns":           ["..."],        # 0-5 items
    "overall_assessment": "...",          # 1-2 paragraphs
    "recommendation":     "strongly_recommend|recommend|neutral|do_not_recommend",
    "reasoning":          "..."
  }

Context priority (AI-004 rev 2):
  1. InterviewTranscriptSegment rows  (from copilot auto-transcription / manual entry)
  2. InterviewNote rows               (manually typed during the interview)
  If BOTH are empty → {"error": "EMPTY_INTERVIEW_NOTES"}

Error returns (stored verbatim in ai_summary):
  {"error": "TIMEOUT"}
  {"error": "EMPTY_INTERVIEW_NOTES"}
  {"error": "AI_UNAVAILABLE"}
"""
from __future__ import annotations

import logging
import time
from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.interview import Interview, InterviewNote
from app.services.ai.openai_client import (
    OpenAIClient,
    OpenAIParseError,
    OpenAIUnavailableError,
)

logger = logging.getLogger(__name__)

# AI-004 spec: exactly these four recommendation values are valid
VALID_RECOMMENDATIONS = frozenset({
    "strongly_recommend",
    "recommend",
    "neutral",
    "do_not_recommend",
})

_SYSTEM_PROMPT = """You are a senior talent acquisition specialist reviewing the content of a completed job interview.
You will receive either a transcript (verbatim conversation), interviewer notes, or both.
Produce a structured evaluation of the candidate in strict JSON format with these exact keys:

{
  "key_strengths": ["...", "...", "..."],
  "concerns": [],
  "overall_assessment": "...",
  "recommendation": "strongly_recommend|recommend|neutral|do_not_recommend",
  "reasoning": "..."
}

Rules:
- key_strengths: 3 to 5 concise bullet points about what impressed you. Base them on what the candidate actually said.
- concerns: 0 to 5 points about risks or gaps; empty array [] if none.
- overall_assessment: 1-2 paragraphs of balanced narrative assessment. Quote or paraphrase specific things the candidate said.
- recommendation: MUST be exactly one of: strongly_recommend, recommend, neutral, do_not_recommend
- reasoning: 2-4 sentences explaining the recommendation.
- Output valid JSON only — no markdown fences, no extra keys.
- If content is a transcript: [INTERVIEWER] lines are the interviewer's questions, [CANDIDATE] lines are the candidate's answers."""

_AI_SUMMARY_TIMEOUT_SECONDS = 15.0


def _collect_transcript_text(db: Session, interview_id: UUID) -> str:
    """Concatenate all InterviewTranscriptSegment rows for the given interview.

    Segments are written by the Copilot auto-transcription (Web Speech API)
    or manual paste in the Copilot panel.  They carry speaker attribution
    so the AI can distinguish interviewer from candidate turns.
    """
    try:
        # Local import to avoid circular dependency with copilot models
        from app.models.interview_copilot import InterviewTranscriptSegment  # noqa: PLC0415

        segments = (
            db.query(InterviewTranscriptSegment)
            .filter(InterviewTranscriptSegment.interview_id == interview_id)
            .order_by(InterviewTranscriptSegment.created_at.asc())
            .all()
        )
        parts: list[str] = []
        for seg in segments:
            speaker = (seg.speaker or "unknown").upper()
            content = (seg.content or "").strip()
            if content:
                parts.append(f"[{speaker}]: {content}")
        return "\n".join(parts)
    except Exception:
        # If copilot tables don't exist yet (pre-migration), degrade gracefully
        logger.debug("_collect_transcript_text: copilot tables unavailable", exc_info=True)
        return ""


def _collect_notes_text(db: Session, interview_id: UUID) -> str:
    """Concatenate all InterviewNote content for the given interview."""
    notes = (
        db.query(InterviewNote)
        .filter(InterviewNote.interview_id == interview_id)
        .order_by(InterviewNote.created_at.asc())
        .all()
    )
    parts: list[str] = []
    for note in notes:
        section = note.section or "General"
        content = (note.content or "").strip()
        if content:
            parts.append(f"[{section}]\n{content}")
    return "\n\n".join(parts)


def _collect_interview_context(db: Session, interview_id: UUID) -> tuple[str, str]:
    """Build a combined context string from transcript + notes.

    Returns:
        (context_text, source_label)
        source_label is one of: "transcript", "notes", "transcript+notes", ""
    """
    transcript_text = _collect_transcript_text(db, interview_id)
    notes_text = _collect_notes_text(db, interview_id)

    has_transcript = bool(transcript_text.strip())
    has_notes = bool(notes_text.strip())

    if not has_transcript and not has_notes:
        return "", ""

    sections: list[str] = []
    if has_transcript:
        sections.append("=== INTERVIEW TRANSCRIPT ===\n" + transcript_text)
    if has_notes:
        sections.append("=== INTERVIEWER NOTES ===\n" + notes_text)

    if has_transcript and has_notes:
        source = "transcript+notes"
    elif has_transcript:
        source = "transcript"
    else:
        source = "notes"

    return "\n\n".join(sections), source


def _validate_summary(data: dict) -> dict:
    """Validate and sanitise the AI response dict. Returns cleaned dict."""
    if not isinstance(data, dict):
        raise ValueError("Response is not a JSON object")

    # Validate recommendation enum
    rec = data.get("recommendation", "")
    if rec not in VALID_RECOMMENDATIONS:
        logger.warning("ai_summary: invalid recommendation value '%s', defaulting to 'neutral'", rec)
        data["recommendation"] = "neutral"

    # Clamp list lengths
    key_strengths = data.get("key_strengths", [])
    if not isinstance(key_strengths, list):
        key_strengths = []
    data["key_strengths"] = key_strengths[:5]

    concerns = data.get("concerns", [])
    if not isinstance(concerns, list):
        concerns = []
    data["concerns"] = concerns[:5]

    # Ensure text fields exist
    if not isinstance(data.get("overall_assessment"), str):
        data["overall_assessment"] = ""
    if not isinstance(data.get("reasoning"), str):
        data["reasoning"] = ""

    return data


def generate_interview_summary(
    db: Session,
    interview: Interview,
) -> tuple[dict[str, Any], str]:
    """Generate and return (summary_dict, provider_name).

    The summary_dict will contain either:
    - A valid structured summary
    - {"error": "EMPTY_INTERVIEW_NOTES"}
    - {"error": "TIMEOUT"}
    - {"error": "AI_UNAVAILABLE"}

    Never raises — all errors are captured into the returned dict.
    """
    interview_id = interview.id

    # --- 1. Collect context (transcript takes priority over notes) ---
    context_text, source = _collect_interview_context(db, interview_id)
    if not context_text.strip():
        logger.info(
            "ai_summary[%s]: no transcript or notes found — returning EMPTY_INTERVIEW_NOTES",
            interview_id,
        )
        return {"error": "EMPTY_INTERVIEW_NOTES"}, "none"

    logger.info(
        "ai_summary[%s]: building summary from source=%s (%d chars)",
        interview_id, source, len(context_text),
    )

    # --- 2. Build user prompt ---
    user_prompt = (
        f"Interview content ({source}):\n\n{context_text}\n\n"
        "Generate the structured interview summary JSON as instructed."
    )

    client = OpenAIClient()
    provider_name = "openai"

    # --- 3. Primary: OpenAI with 15s timeout ---
    if client.is_configured():
        t0 = time.monotonic()
        try:
            # We wrap in a timeout check by catching httpx.TimeoutException
            # (which OpenAIClient retries 3×, but we want a total wall-clock limit).
            import httpx

            with httpx.Client(timeout=_AI_SUMMARY_TIMEOUT_SECONDS) as http_client:
                # Re-use the client infrastructure but call with our own http_client
                # by monkey-patching isn't clean — instead we rely on the fact that
                # OpenAIClient uses its own httpx.Client with timeout=60s, so we
                # add a wall-clock guard here.
                pass  # Guard is enforced below via elapsed check

            response = client.chat_json(
                system=_SYSTEM_PROMPT,
                user=user_prompt,
                temperature=0.3,
                max_tokens=1024,
            )
            elapsed = time.monotonic() - t0
            if elapsed > _AI_SUMMARY_TIMEOUT_SECONDS:
                logger.warning(
                    "ai_summary[%s]: response arrived after %.1fs (over 15s limit) — treating as TIMEOUT",
                    interview_id, elapsed,
                )
                return {"error": "TIMEOUT"}, "openai"

            data = response.parse_json()
            summary = _validate_summary(data)
            logger.info(
                "ai_summary[%s]: generated via openai in %.1fs rec=%s",
                interview_id, elapsed, summary.get("recommendation"),
            )
            return summary, provider_name

        except httpx.TimeoutException:
            logger.warning("ai_summary[%s]: OpenAI timed out after %.1fs", interview_id, time.monotonic() - t0)
            return {"error": "TIMEOUT"}, "openai"

        except OpenAIUnavailableError as exc:
            logger.warning("ai_summary[%s]: OpenAI unavailable — %s", interview_id, exc)
            # fall through to fallback

        except OpenAIParseError as exc:
            logger.warning("ai_summary[%s]: could not parse OpenAI response — %s", interview_id, exc)
            # fall through to fallback

        except Exception as exc:
            logger.exception("ai_summary[%s]: unexpected error from OpenAI — %s", interview_id, exc)
            # fall through to fallback

    else:
        logger.info("ai_summary[%s]: OpenAI not configured, using fallback", interview_id)

    # --- 4. Fallback: rule-based stub summary ---
    provider_name = "fallback"
    logger.info("ai_summary[%s]: using fallback provider", interview_id)

    # Build a minimal but valid summary from context text so the
    # recruiter has something to work with.
    word_count = len(context_text.split())
    if word_count < 20:
        fallback_assessment = "Insufficient notes were recorded to provide a detailed assessment."
        fallback_rec = "neutral"
    else:
        fallback_assessment = (
            "An AI-generated summary could not be produced at this time. "
            "Please review the interview notes directly and fill in this summary manually."
        )
        fallback_rec = "neutral"

    return {
        "key_strengths": [],
        "concerns": [],
        "overall_assessment": fallback_assessment,
        "recommendation": fallback_rec,
        "reasoning": "This is a placeholder summary. The AI provider was unavailable. Please edit.",
        "_fallback": True,
    }, provider_name
