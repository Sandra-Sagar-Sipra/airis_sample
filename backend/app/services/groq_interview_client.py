"""Groq client dedicated to the AI Screening Interview feature.

Uses GROQ_API_KEY_AIinterview from settings and the llama-3.3-70b-versatile
model to conduct dynamic, recruiter-style conversational interviews.

Provides:
  GroqInterviewClient.chat()           – plain conversational turn
  GroqInterviewClient.chat_json()      – JSON-structured response
  GroqInterviewClient.is_configured()  – quick health check
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

_GROQ_CHAT_URL = "{base}/chat/completions"


class GroqInterviewUnavailableError(Exception):
    """Raised when Groq cannot return a usable response."""


class GroqInterviewParseError(Exception):
    """Raised when the JSON response cannot be parsed."""


@dataclass
class GroqResponse:
    content: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    model: str = ""
    duration_ms: int = 0
    raw: dict = field(default_factory=dict)

    def parse_json(self) -> Any:
        """Extract JSON from content, tolerating markdown fences."""
        text = self.content.strip()
        fence = re.search(r"```(?:json)?\s*([\s\S]+?)```", text, re.IGNORECASE)
        if fence:
            text = fence.group(1).strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # Last resort: extract first {...} block
            brace = re.search(r"\{[\s\S]+\}", text)
            if brace:
                try:
                    return json.loads(brace.group())
                except json.JSONDecodeError:
                    pass
        raise GroqInterviewParseError(f"Cannot parse JSON from: {text[:300]}")


class GroqInterviewClient:
    """HTTP client for Groq AI interview conversations."""

    def __init__(self) -> None:
        settings = get_settings()
        self._api_key = settings.groq_api_key_aiinterview
        self._model = settings.groq_aiinterview_model
        self._base = settings.groq_aiinterview_api_base.rstrip("/")
        self._timeout = settings.groq_aiinterview_timeout_seconds

    def is_configured(self) -> bool:
        return bool(self._api_key)

    # ── Core HTTP call ────────────────────────────────────────────────────────

    @retry(
        retry=retry_if_exception_type(httpx.TransportError),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=8),
        reraise=True,
    )
    def _post(
        self,
        messages: list[dict],
        *,
        temperature: float = 0.7,
        max_tokens: int = 512,
        response_format: dict | None = None,
    ) -> dict:
        if not self._api_key:
            raise GroqInterviewUnavailableError("GROQ_API_KEY_AIinterview is not configured.")

        payload: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if response_format:
            payload["response_format"] = response_format

        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

        url = _GROQ_CHAT_URL.format(base=self._base)
        t0 = time.monotonic()
        try:
            resp = httpx.post(
                url, json=payload, headers=headers, timeout=self._timeout
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            logger.error(
                "groq_interview.http_error status=%s body=%.300s",
                exc.response.status_code,
                exc.response.text,
            )
            raise GroqInterviewUnavailableError(
                f"Groq returned HTTP {exc.response.status_code}: {exc.response.text[:200]}"
            ) from exc
        except httpx.TransportError as exc:
            logger.warning("groq_interview.transport_error: %s", exc)
            raise

        duration_ms = int((time.monotonic() - t0) * 1000)
        data = resp.json()
        logger.debug(
            "groq_interview.call ok model=%s tokens=%s+%s dur=%dms",
            data.get("model"),
            data.get("usage", {}).get("prompt_tokens"),
            data.get("usage", {}).get("completion_tokens"),
            duration_ms,
        )
        return data

    # ── Public helpers ────────────────────────────────────────────────────────

    def chat(
        self,
        messages: list[dict],
        *,
        temperature: float = 0.7,
        max_tokens: int = 512,
    ) -> GroqResponse:
        """Send a conversation and return plain text response."""
        try:
            data = self._post(messages, temperature=temperature, max_tokens=max_tokens)
            choice = data["choices"][0]["message"]["content"]
            usage = data.get("usage", {})
            return GroqResponse(
                content=choice.strip(),
                prompt_tokens=usage.get("prompt_tokens", 0),
                completion_tokens=usage.get("completion_tokens", 0),
                model=data.get("model", self._model),
                raw=data,
            )
        except GroqInterviewUnavailableError:
            raise
        except Exception as exc:
            raise GroqInterviewUnavailableError(f"Unexpected Groq error: {exc}") from exc

    def chat_json(
        self,
        messages: list[dict],
        *,
        temperature: float = 0.3,
        max_tokens: int = 1024,
    ) -> GroqResponse:
        """Send a conversation and expect a JSON response."""
        try:
            data = self._post(
                messages,
                temperature=temperature,
                max_tokens=max_tokens,
                response_format={"type": "json_object"},
            )
            choice = data["choices"][0]["message"]["content"]
            usage = data.get("usage", {})
            return GroqResponse(
                content=choice.strip(),
                prompt_tokens=usage.get("prompt_tokens", 0),
                completion_tokens=usage.get("completion_tokens", 0),
                model=data.get("model", self._model),
                raw=data,
            )
        except GroqInterviewUnavailableError:
            raise
        except Exception as exc:
            raise GroqInterviewUnavailableError(f"Unexpected Groq error: {exc}") from exc
