"""Centralized OpenAI HTTP client for the AI Screening layer.

Uses httpx (already a project dependency) to call the OpenAI chat completions
endpoint directly — no openai SDK needed.  All AI calls are synchronous and
should be dispatched from FastAPI BackgroundTasks so they never block request
threads.

Features:
- Configurable model, timeout, retries via tenacity
- Structured JSON extraction with fallback error handling
- Token usage tracking returned with every response
- Cost-free fallback when OPENAI_API_KEY is not configured
"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from app.core.config import get_settings

logger = logging.getLogger(__name__)


class OpenAIUnavailableError(Exception):
    """Raised when OpenAI cannot return a usable response."""


class OpenAIParseError(Exception):
    """Raised when the response cannot be parsed as valid JSON."""


@dataclass
class AIResponse:
    content: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    model: str = ""
    duration_ms: int = 0
    raw: dict = field(default_factory=dict)

    def parse_json(self) -> Any:
        """Extract JSON from the assistant content, tolerating markdown fences."""
        text = self.content.strip()
        # Strip ```json ... ``` fences if present
        fence = re.search(r"```(?:json)?\s*([\s\S]+?)```", text, re.IGNORECASE)
        if fence:
            text = fence.group(1).strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise OpenAIParseError(f"Could not parse AI response as JSON: {exc}\nRaw: {text[:500]}") from exc


class OpenAIClient:
    """Thin httpx wrapper around OpenAI chat completions."""

    def __init__(self) -> None:
        s = get_settings()
        self._api_key = (s.openai_api_key or "").strip()
        self._base = (s.openai_api_base or "https://api.openai.com/v1").rstrip("/")
        self._model = s.openai_screening_model or "gpt-4.1-mini"
        self._timeout = float(s.openai_timeout_seconds or 60.0)

    def is_configured(self) -> bool:
        return bool(self._api_key)

    def transcribe_audio(
        self,
        audio_data: bytes,
        filename: str = "audio.webm",
        language: str = "en",
    ) -> str:
        """Transcribe audio bytes using OpenAI Whisper (model: whisper-1).

        Sends the audio as a multipart upload to /v1/audio/transcriptions.
        Returns the transcribed text, or an empty string if the audio was
        silent / too short / unintelligible.  Callers should skip saving a
        transcript segment when the return value is empty.

        Raises OpenAIUnavailableError on network / API key errors.
        """
        if not self.is_configured():
            raise OpenAIUnavailableError("OPENAI_API_KEY is not configured")

        url = f"{self._base}/audio/transcriptions"
        headers = {"Authorization": f"Bearer {self._api_key}"}

        # Infer MIME type from file extension so Whisper's server-side parser
        # knows what format to expect.
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "webm"
        mime = {
            "webm": "audio/webm",
            "ogg": "audio/ogg",
            "mp3": "audio/mpeg",
            "mp4": "audio/mp4",
            "wav": "audio/wav",
            "m4a": "audio/mp4",
            "flac": "audio/flac",
        }.get(ext, "audio/webm")

        t0 = time.monotonic()
        logger.info(
            "openai.transcribe model=whisper-1 bytes=%d lang=%s",
            len(audio_data), language,
        )

        with httpx.Client(timeout=30.0) as client:
            resp = client.post(
                url,
                headers=headers,
                files={"file": (filename, audio_data, mime)},
                data={
                    "model": "whisper-1",
                    "language": language,
                    "response_format": "json",
                },
            )

        duration_ms = int((time.monotonic() - t0) * 1000)

        if resp.status_code >= 400:
            body = (resp.text or "")[:400]
            logger.warning(
                "openai.transcribe.error status=%d body=%s duration_ms=%d",
                resp.status_code, body, duration_ms,
            )
            raise OpenAIUnavailableError(
                f"Whisper HTTP {resp.status_code}: {body[:200]}"
            )

        data = resp.json()
        text = (data.get("text") or "").strip()
        logger.info(
            "openai.transcribe.completed duration_ms=%d chars=%d",
            duration_ms, len(text),
        )
        return text

    @retry(
        reraise=True,
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=15),
        retry=retry_if_exception_type(
            (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)
        ),
    )
    def chat_json(
        self,
        *,
        system: str,
        user: str,
        temperature: float = 0.2,
        max_tokens: int = 2048,
    ) -> AIResponse:
        """Call chat completions and return an AIResponse.

        Caller is responsible for calling AIResponse.parse_json() to get the
        structured payload — this keeps parsing errors separable from network
        errors.
        """
        if not self.is_configured():
            raise OpenAIUnavailableError("OPENAI_API_KEY is not configured")

        url = f"{self._base}/chat/completions"
        payload: dict[str, Any] = {
            "model": self._model,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

        t0 = time.monotonic()
        logger.info(
            "openai.chat_json model=%s timeout=%.1fs system_len=%d user_len=%d",
            self._model,
            self._timeout,
            len(system),
            len(user),
        )

        with httpx.Client(timeout=self._timeout) as client:
            resp = client.post(url, headers=headers, json=payload)

        duration_ms = int((time.monotonic() - t0) * 1000)

        if resp.status_code >= 400:
            body = (resp.text or "")[:800]
            logger.warning(
                "openai.http_error status=%d body=%s duration_ms=%d",
                resp.status_code, body, duration_ms
            )
            raise OpenAIUnavailableError(f"OpenAI HTTP {resp.status_code}: {body[:200]}")

        data = resp.json()
        choices = data.get("choices") or []
        if not choices:
            raise OpenAIUnavailableError("OpenAI returned empty choices")

        message = choices[0].get("message") or {}
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            raise OpenAIUnavailableError("OpenAI returned empty content")

        usage = data.get("usage") or {}
        result = AIResponse(
            content=content.strip(),
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            model=data.get("model", self._model),
            duration_ms=duration_ms,
            raw=data,
        )

        logger.info(
            "openai.chat_json.completed model=%s duration_ms=%d prompt_tokens=%d completion_tokens=%d",
            result.model, result.duration_ms, result.prompt_tokens, result.completion_tokens,
        )
        return result
