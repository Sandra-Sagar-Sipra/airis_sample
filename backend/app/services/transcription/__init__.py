"""Transcription provider abstraction.

Quick usage::

    from app.services.transcription import create_transcription_provider

    provider = create_transcription_provider()
    if not provider.is_configured():
        raise HTTPException(status_code=503, detail="No transcription provider configured.")

    text = provider.transcribe(audio_data=..., filename="audio.webm", language="en")
"""
from .base import TranscriptionProvider, TranscriptionUnavailableError
from .factory import create_transcription_provider

__all__ = [
    "TranscriptionProvider",
    "TranscriptionUnavailableError",
    "create_transcription_provider",
]
