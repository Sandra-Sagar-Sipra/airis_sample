"""AI-004 (rev 2): Interview summary generation — transcript-aware tests.

Acceptance criteria:
  1. generate_interview_summary returns EMPTY_INTERVIEW_NOTES when both
     transcript and notes are empty.
  2. generate_interview_summary uses transcript segments when no notes exist.
  3. generate_interview_summary uses notes when no transcript exists (backward compat).
  4. generate_interview_summary merges transcript + notes when both exist.
  5. _collect_transcript_text degrades gracefully when copilot tables are unavailable.
  6. _collect_interview_context returns correct source labels.
  7. Fallback summary is returned when AI provider is unavailable.
  8. Transcript context is labelled correctly in the user prompt (source=transcript).
  9. Notes context is labelled correctly in the user prompt (source=notes).
 10. Combined context label is "transcript+notes".
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

from app.services.ai.interview_summary import (
    _collect_interview_context,
    _collect_notes_text,
    _collect_transcript_text,
    generate_interview_summary,
)


# ── Fixtures ───────────────────────────────────────────────────────────────────

def _make_interview(scheduled_at=None):
    iv = MagicMock()
    iv.id = uuid4()
    iv.organization_id = uuid4()
    iv.status = "completed"
    iv.scheduled_at = scheduled_at or (datetime.now(UTC) - timedelta(hours=1))
    iv.candidate_id = uuid4()
    iv.job_id = uuid4()
    return iv


def _make_note(content: str, section: str = "General"):
    note = MagicMock()
    note.section = section
    note.content = content
    return note


def _make_segment(content: str, speaker: str = "interviewer"):
    seg = MagicMock()
    seg.speaker = speaker
    seg.content = content
    return seg


def _make_db(notes=None, segments=None):
    """Return a mock DB that returns given notes and segments from query()."""
    db = MagicMock()

    # Build a chainable query mock for both models
    def _query(model):
        q = MagicMock()
        if "InterviewNote" in str(model):
            rows = notes or []
        elif "InterviewTranscriptSegment" in str(model):
            rows = segments or []
        else:
            rows = []
        q.filter.return_value = q
        q.order_by.return_value = q
        q.all.return_value = rows
        return q

    db.query.side_effect = _query
    return db


# ── 1. Both empty → EMPTY_INTERVIEW_NOTES ─────────────────────────────────────

def test_empty_notes_and_transcript_returns_empty_error():
    interview = _make_interview()
    db = _make_db(notes=[], segments=[])

    summary, provider = generate_interview_summary(db, interview)

    assert summary.get("error") == "EMPTY_INTERVIEW_NOTES"
    assert provider == "none"


# ── 2. Transcript only ────────────────────────────────────────────────────────

def test_transcript_used_when_no_notes():
    interview = _make_interview()
    segs = [
        _make_segment("Tell me about your Python experience.", "interviewer"),
        _make_segment("I have 5 years of Python development.", "candidate"),
    ]
    db = _make_db(notes=[], segments=segs)

    context, source = _collect_interview_context(db, interview.id)
    assert source == "transcript"
    assert "[INTERVIEWER]" in context
    assert "[CANDIDATE]" in context
    assert "Python" in context


# ── 3. Notes only (backward compatibility) ────────────────────────────────────

def test_notes_used_when_no_transcript():
    interview = _make_interview()
    notes = [_make_note("Strong problem solver. Good communication.")]
    db = _make_db(notes=notes, segments=[])

    context, source = _collect_interview_context(db, interview.id)
    assert source == "notes"
    assert "Strong problem solver" in context
    assert "INTERVIEW TRANSCRIPT" not in context


# ── 4. Both transcript and notes present ──────────────────────────────────────

def test_transcript_and_notes_merged():
    interview = _make_interview()
    notes = [_make_note("Extra note from recruiter.")]
    segs = [_make_segment("What's your biggest weakness?", "interviewer")]
    db = _make_db(notes=notes, segments=segs)

    context, source = _collect_interview_context(db, interview.id)
    assert source == "transcript+notes"
    assert "INTERVIEW TRANSCRIPT" in context
    assert "INTERVIEWER NOTES" in context
    assert "biggest weakness" in context
    assert "Extra note" in context


# ── 5. Transcript collection degrades if copilot tables unavailable ───────────

def test_collect_transcript_degrades_gracefully_on_import_error():
    db = MagicMock()
    # Make db.query raise ImportError (simulates missing table / model)
    db.query.side_effect = ImportError("no module")

    result = _collect_transcript_text(db, uuid4())
    assert result == ""


# ── 6. Source labels are correct ──────────────────────────────────────────────

@pytest.mark.parametrize("has_transcript,has_notes,expected_source", [
    (True,  False, "transcript"),
    (False, True,  "notes"),
    (True,  True,  "transcript+notes"),
])
def test_source_labels(has_transcript, has_notes, expected_source):
    segs = [_make_segment("Hello")] if has_transcript else []
    notes = [_make_note("Note")] if has_notes else []
    db = _make_db(notes=notes, segments=segs)

    _, source = _collect_interview_context(db, uuid4())
    assert source == expected_source


# ── 7. Fallback summary when AI is unavailable ────────────────────────────────

def test_fallback_summary_when_openai_not_configured():
    interview = _make_interview()
    segs = [_make_segment("I worked at Google for 3 years.", "candidate")]
    db = _make_db(notes=[], segments=segs)

    with patch("app.services.ai.interview_summary.OpenAIClient") as MockClient:
        mock_client = MagicMock()
        mock_client.is_configured.return_value = False
        MockClient.return_value = mock_client

        summary, provider = generate_interview_summary(db, interview)

    assert provider == "fallback"
    assert "_fallback" in summary
    assert summary["_fallback"] is True
    assert summary.get("recommendation") == "neutral"


# ── 8. User prompt labels source=transcript ───────────────────────────────────

def test_user_prompt_labels_transcript_source():
    interview = _make_interview()
    segs = [_make_segment("I'm proficient in Kubernetes.", "candidate")]
    db = _make_db(notes=[], segments=segs)

    captured_prompts: list[str] = []

    with patch("app.services.ai.interview_summary.OpenAIClient") as MockClient:
        mock_client = MagicMock()
        mock_client.is_configured.return_value = True

        def fake_chat_json(system, user, temperature, max_tokens):
            captured_prompts.append(user)
            raise Exception("abort — we only care about the prompt")

        mock_client.chat_json.side_effect = fake_chat_json
        MockClient.return_value = mock_client

        generate_interview_summary(db, interview)

    assert captured_prompts, "chat_json was never called"
    assert "transcript" in captured_prompts[0].lower()
    assert "Kubernetes" in captured_prompts[0]


# ── 9. User prompt labels source=notes ────────────────────────────────────────

def test_user_prompt_labels_notes_source():
    interview = _make_interview()
    notes = [_make_note("Excellent system design skills.")]
    db = _make_db(notes=notes, segments=[])

    captured_prompts: list[str] = []

    with patch("app.services.ai.interview_summary.OpenAIClient") as MockClient:
        mock_client = MagicMock()
        mock_client.is_configured.return_value = True

        def fake_chat_json(system, user, temperature, max_tokens):
            captured_prompts.append(user)
            raise Exception("abort")

        mock_client.chat_json.side_effect = fake_chat_json
        MockClient.return_value = mock_client

        generate_interview_summary(db, interview)

    assert "notes" in captured_prompts[0].lower()
    assert "system design" in captured_prompts[0].lower()


# ── 10. User prompt labels source=transcript+notes ────────────────────────────

def test_user_prompt_labels_combined_source():
    interview = _make_interview()
    notes = [_make_note("Good energy.")]
    segs = [_make_segment("What motivates you?", "interviewer")]
    db = _make_db(notes=notes, segments=segs)

    captured_prompts: list[str] = []

    with patch("app.services.ai.interview_summary.OpenAIClient") as MockClient:
        mock_client = MagicMock()
        mock_client.is_configured.return_value = True

        def fake_chat_json(system, user, temperature, max_tokens):
            captured_prompts.append(user)
            raise Exception("abort")

        mock_client.chat_json.side_effect = fake_chat_json
        MockClient.return_value = mock_client

        generate_interview_summary(db, interview)

    assert "transcript+notes" in captured_prompts[0].lower()


# ── 11. Transcript segments formatted with speaker labels ─────────────────────

def test_transcript_segments_include_speaker_labels():
    segs = [
        _make_segment("Describe your background.", "interviewer"),
        _make_segment("I studied CS at MIT.", "candidate"),
    ]
    db = _make_db(notes=[], segments=segs)

    text = _collect_transcript_text(db, uuid4())
    assert "[INTERVIEWER]" in text
    assert "[CANDIDATE]" in text
    assert "background" in text
    assert "MIT" in text


# ── 12. Notes segments formatted with section headers ─────────────────────────

def test_notes_include_section_headers():
    notes = [
        _make_note("Excellent Python.", "Technical"),
        _make_note("Very professional.", "Culture Fit"),
    ]
    db = _make_db(notes=notes, segments=[])

    text = _collect_notes_text(db, uuid4())
    assert "[Technical]" in text
    assert "[Culture Fit]" in text
    assert "Excellent Python" in text
