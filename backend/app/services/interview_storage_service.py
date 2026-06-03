"""Supabase Storage service for AI screening interview recordings.

Storage layout (inside the 'recordings' bucket):
  {screening_id}/
    interview.webm       — full raw recording
    transcript.json      — full conversation transcript
    analysis.json        — per-question timing + transcript data
    segments/
      q1.webm            — per-question video clips (browser-captured)
      q2.webm
      ...

Object keys do NOT include the bucket name — the bucket is set on the client.
Combining key `{id}/interview.webm` with bucket `recordings` gives the correct
Supabase URL: /storage/v1/object/recordings/{id}/interview.webm
"""
from __future__ import annotations

import json
import logging
from typing import Any
from uuid import UUID

from app.candidate_management.storage import SupabaseStorageClient

logger = logging.getLogger(__name__)

_RECORDINGS_BUCKET = "recordings"


def _client() -> SupabaseStorageClient:
    """Return a storage client wired to the recordings bucket."""
    import os
    client = SupabaseStorageClient()
    client.bucket = os.getenv("SUPABASE_RECORDINGS_BUCKET", _RECORDINGS_BUCKET)
    return client


# ── Upload helpers ────────────────────────────────────────────────────────────

def upload_interview_video(screening_id: UUID, video_bytes: bytes) -> str:
    """Upload the full interview recording. Returns the object key on success."""
    if not video_bytes:
        logger.warning("[UPLOAD] video_bytes is empty — skipping upload screening=%s", screening_id)
        return ""

    key = f"{screening_id}/interview.webm"   # path inside bucket, NO bucket prefix
    client = _client()

    if not client.is_configured():
        logger.error(
            "[UPLOAD] Supabase not configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/bucket missing) "
            "— video will NOT be stored screening=%s", screening_id
        )
        return ""

    try:
        logger.info("[UPLOAD] starting Supabase upload screening=%s size=%d bucket=%s key=%s",
                    screening_id, len(video_bytes), client.bucket, key)
        client.upload_bytes(object_key=key, content=video_bytes, content_type="video/webm")
        logger.info("[UPLOAD] Supabase success screening=%s key=%s", screening_id, key)
        return key
    except Exception as exc:
        logger.error("[UPLOAD] Supabase failure screening=%s key=%s error=%s", screening_id, key, exc)
        raise


def upload_segment_video(
    screening_id: UUID, question_number: int, video_bytes: bytes
) -> str:
    """Upload a per-question answer clip. Returns the object key on success."""
    if not video_bytes:
        return ""

    key = f"{screening_id}/segments/q{question_number}.webm"
    client = _client()

    if not client.is_configured():
        logger.warning("[UPLOAD] Supabase not configured — skipping segment upload q=%d", question_number)
        return ""

    try:
        client.upload_bytes(object_key=key, content=video_bytes, content_type="video/webm")
        logger.info("[UPLOAD] segment uploaded screening=%s q=%d size=%d key=%s",
                    screening_id, question_number, len(video_bytes), key)
        return key
    except Exception as exc:
        logger.error("[UPLOAD] segment failure screening=%s q=%d error=%s", screening_id, question_number, exc)
        raise


def upload_transcript(screening_id: UUID, transcript: list[dict[str, Any]]) -> str:
    key = f"{screening_id}/transcript.json"
    client = _client()
    if not client.is_configured():
        return ""
    try:
        payload = json.dumps(transcript, ensure_ascii=False, indent=2).encode()
        client.upload_bytes(object_key=key, content=payload, content_type="application/json")
        return key
    except Exception as exc:
        logger.warning("[UPLOAD] transcript failure screening=%s error=%s", screening_id, exc)
        return ""


def upload_analysis(screening_id: UUID, analysis: dict[str, Any]) -> str:
    key = f"{screening_id}/analysis.json"
    client = _client()
    if not client.is_configured():
        return ""
    try:
        payload = json.dumps(analysis, ensure_ascii=False, indent=2).encode()
        client.upload_bytes(object_key=key, content=payload, content_type="application/json")
        return key
    except Exception as exc:
        logger.warning("[UPLOAD] analysis failure screening=%s error=%s", screening_id, exc)
        return ""


def get_signed_url(object_key: str, expires_in: int = 3600) -> str:
    """Return a signed download URL for a stored object (1-hour default TTL)."""
    if not object_key:
        return ""
    client = _client()
    if not client.is_configured():
        return ""
    try:
        url = client.create_signed_download_url(
            object_key=object_key, expires_in_seconds=expires_in
        )
        logger.debug("[UPLOAD] signed_url generated key=%s", object_key)
        return url
    except Exception as exc:
        logger.warning("[UPLOAD] signed_url_failed key=%s error=%s", object_key, exc)
        return ""
