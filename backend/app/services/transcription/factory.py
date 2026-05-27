"""Transcription provider factory.

Reads ``TRANSCRIPTION_PROVIDER`` from settings and returns the appropriate
:class:`~app.services.transcription.base.TranscriptionProvider` instance.

Supported values
----------------
``whisper`` (default)
    OpenAI Whisper via :class:`~app.services.transcription.whisper.WhisperProvider`.
    Requires ``OPENAI_API_KEY`` to be set; falls back gracefully (provider
    returns ``is_configured() == False``) when the key is absent.

Additional providers (e.g. ``assemblyai-batch``, ``deepgram``) can be wired
here as the project grows without changing any other code.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

from .base import TranscriptionProvider


def create_transcription_provider() -> TranscriptionProvider:
    """Return a :class:`TranscriptionProvider` based on current settings.

    The returned provider may not be configured (check
    ``provider.is_configured()``).  Callers should surface a 503 when the
    provider is not configured rather than raising an exception here, so
    startup is never blocked.
    """
    from app.core.config import get_settings  # local import → avoids circular deps at module load

    settings = get_settings()
    raw_name: str = (getattr(settings, "transcription_provider", None) or "whisper").strip().lower()

    if raw_name == "whisper":
        from .whisper import WhisperProvider
        provider = WhisperProvider()
        logger.debug("transcription.factory: using WhisperProvider (configured=%s)", provider.is_configured())
        return provider

    # Unknown provider — warn and return unconfigured Whisper as fallback so
    # the app still boots; the 503 at request time is more user-friendly than
    # an ImportError at startup.
    logger.warning(
        "transcription.factory: unknown provider %r — falling back to WhisperProvider",
        raw_name,
    )
    from .whisper import WhisperProvider
    return WhisperProvider()
