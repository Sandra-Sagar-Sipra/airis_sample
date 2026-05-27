"""Abstract base for audio transcription providers.

All concrete providers (Whisper, AssemblyAI-batch, …) implement this
interface so the rest of the codebase is agnostic to which service is
actually being called.
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class TranscriptionUnavailableError(Exception):
    """Raised when the transcription provider cannot return a usable result."""


class TranscriptionProvider(ABC):
    """Synchronous audio-to-text interface."""

    @abstractmethod
    def is_configured(self) -> bool:
        """Return ``True`` iff the provider has valid credentials and can
        accept transcription requests.  Callers should check this before
        calling :meth:`transcribe` to produce a meaningful error message."""
        ...

    @abstractmethod
    def transcribe(
        self,
        *,
        audio_data: bytes,
        filename: str = "audio.webm",
        language: str = "en",
    ) -> str:
        """Transcribe *audio_data* and return the recognised text.

        Args:
            audio_data: Raw audio bytes (webm/ogg/mp4/wav).
            filename:   Hint for the provider's format parser.
            language:   BCP-47 language code passed to the provider as a hint.

        Returns:
            The transcribed text.  Empty string when the audio was silent or
            too short to produce a result.

        Raises:
            TranscriptionUnavailableError: Provider rejected the request or is
                unreachable.
        """
        ...

    @property
    def provider_name(self) -> str:
        """Human-readable provider identifier (used in logs / metadata)."""
        return type(self).__name__
