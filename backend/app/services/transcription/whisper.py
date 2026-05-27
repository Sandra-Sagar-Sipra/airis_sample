"""OpenAI Whisper transcription provider.

Wraps the existing :class:`~app.services.ai.openai_client.OpenAIClient`
so it can be swapped for other providers via the factory.
"""
from __future__ import annotations

import logging

from app.services.ai.openai_client import OpenAIClient, OpenAIUnavailableError

from .base import TranscriptionProvider, TranscriptionUnavailableError

logger = logging.getLogger(__name__)


class WhisperProvider(TranscriptionProvider):
    """Transcribes audio via OpenAI Whisper (model: whisper-1)."""

    def __init__(self) -> None:
        self._client = OpenAIClient()

    # ── TranscriptionProvider interface ───────────────────────────────────────

    def is_configured(self) -> bool:
        return self._client.is_configured()

    def transcribe(
        self,
        *,
        audio_data: bytes,
        filename: str = "audio.webm",
        language: str = "en",
    ) -> str:
        if not self.is_configured():
            raise TranscriptionUnavailableError(
                "OpenAI Whisper is not configured — OPENAI_API_KEY is missing."
            )
        try:
            return self._client.transcribe_audio(
                audio_data=audio_data,
                filename=filename,
                language=language,
            )
        except OpenAIUnavailableError as exc:
            logger.warning("whisper_provider.unavailable: %s", exc)
            raise TranscriptionUnavailableError(str(exc)) from exc

    @property
    def provider_name(self) -> str:
        return "whisper"
