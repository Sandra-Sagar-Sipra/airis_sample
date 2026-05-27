"""OpenAI-compatible chat completion with Groq-first provider fallback for JSON parsing."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)

GROQ_API_BASE = "https://api.groq.com/openai/v1"
GROQ_MODEL = "llama-3.3-70b-versatile"
DEFAULT_PARSE_TIMEOUT = 30.0


class LlmJsonCompletionError(Exception):
    """All configured providers failed or a non-retryable error occurred."""

    def __init__(self, message: str, *, last_status: int | None = None) -> None:
        super().__init__(message)
        self.last_status = last_status


@dataclass(frozen=True)
class _Provider:
    label: str
    api_key: str
    api_base: str
    model: str
    timeout_seconds: float
    version_tag: str


def _strip_json_fences(content: str) -> str:
    text = content.strip()
    if "```json" in text:
        return text.split("```json", 1)[1].split("```", 1)[0].strip()
    if "```" in text:
        return text.split("```", 1)[1].split("```", 1)[0].strip()
    return text


def _is_retryable_http(status: int) -> bool:
    return status in (429, 502, 503, 504)


def _resolve_groq_backup_key(settings: Settings) -> str | None:
    """Backup Groq for parse: GROQ_API_KEY_BACKUP, else legacy GROQ_API_KEY_ATS."""
    for candidate in (settings.groq_api_key_backup, settings.groq_ats_api_key):
        if candidate:
            return candidate
    return None


def build_parse_providers(settings: Settings | None = None) -> list[_Provider]:
    """Primary Groq, then backup Groq key, then xAI Grok."""
    s = settings or get_settings()
    providers: list[_Provider] = []
    seen_keys: set[str] = set()

    def add(label: str, key: str | None, base: str, model: str, timeout: float, version_tag: str) -> None:
        if not key or key in seen_keys:
            return
        seen_keys.add(key)
        providers.append(
            _Provider(
                label=label,
                api_key=key,
                api_base=base.rstrip("/"),
                model=model,
                timeout_seconds=timeout,
                version_tag=version_tag,
            )
        )

    add(
        "groq",
        s.groq_api_key,
        GROQ_API_BASE,
        GROQ_MODEL,
        DEFAULT_PARSE_TIMEOUT,
        f"groq-{GROQ_MODEL}",
    )
    backup_groq = _resolve_groq_backup_key(s)
    add(
        "groq-backup",
        backup_groq,
        GROQ_API_BASE,
        GROQ_MODEL,
        max(DEFAULT_PARSE_TIMEOUT, float(s.groq_ats_timeout_seconds)),
        f"groq-backup-{GROQ_MODEL}",
    )
    grok_key = s.grok_api_key
    if grok_key and grok_key not in seen_keys:
        add(
            "grok",
            grok_key,
            s.grok_api_base,
            s.grok_model,
            max(DEFAULT_PARSE_TIMEOUT, float(s.grok_timeout_seconds)),
            f"grok-{s.grok_model}",
        )

    return providers


def _parse_response_body(result: dict[str, Any]) -> dict[str, Any]:
    choices = result.get("choices") or []
    if not choices:
        raise json.JSONDecodeError("empty choices", "", 0)
    message = choices[0].get("message") or {}
    content = message.get("content")
    if not content or not str(content).strip():
        raise json.JSONDecodeError("empty content", "", 0)
    return json.loads(_strip_json_fences(str(content)))


def _request_sync(provider: _Provider, prompt: str) -> dict[str, Any]:
    with httpx.Client(timeout=provider.timeout_seconds) as client:
        response = client.post(
            f"{provider.api_base}/chat/completions",
            headers={
                "Authorization": f"Bearer {provider.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": provider.model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
                "max_tokens": 1500,
            },
        )
        response.raise_for_status()
        return _parse_response_body(response.json())


async def _request_async(provider: _Provider, prompt: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=provider.timeout_seconds) as client:
        response = await client.post(
            f"{provider.api_base}/chat/completions",
            headers={
                "Authorization": f"Bearer {provider.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": provider.model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
                "max_tokens": 1500,
            },
        )
        response.raise_for_status()
        return _parse_response_body(response.json())


def _should_try_next(exc: BaseException, *, allow_backup: bool) -> bool:
    if not allow_backup:
        return False
    if isinstance(exc, httpx.TimeoutException):
        return True
    if isinstance(exc, json.JSONDecodeError):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        # Bad primary key (401/403) — still try backup when another key is configured.
        if status in (401, 403):
            return True
        if status == 400:
            return False
        return _is_retryable_http(status) or status >= 500
    return False


def complete_json_sync(
    prompt: str,
    *,
    settings: Settings | None = None,
    timeout_seconds: float | None = None,
) -> tuple[dict[str, Any], str]:
    """Try providers in order; return (parsed_json, version_tag)."""
    s = settings or get_settings()
    providers = build_parse_providers(s)
    if not providers:
        raise LlmJsonCompletionError("No LLM API keys configured for parsing.")

    allow_backup = bool(s.ai_parse_enable_backup)
    last_exc: BaseException | None = None
    last_status: int | None = None

    for index, provider in enumerate(providers):
        if timeout_seconds is not None:
            provider = _Provider(
                label=provider.label,
                api_key=provider.api_key,
                api_base=provider.api_base,
                model=provider.model,
                timeout_seconds=timeout_seconds,
                version_tag=provider.version_tag,
            )
        try:
            payload = _request_sync(provider, prompt)
            if index > 0:
                logger.warning(
                    "llm_json_completion.fallback_success primary_failed=true provider=%s",
                    provider.label,
                )
            return payload, provider.version_tag
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if isinstance(exc, httpx.HTTPStatusError):
                last_status = exc.response.status_code
            logger.warning(
                "llm_json_completion.provider_failed provider=%s error=%s",
                provider.label,
                exc,
            )
            if index + 1 < len(providers) and _should_try_next(exc, allow_backup=allow_backup):
                logger.warning(
                    "llm_json_completion.trying_backup next=%s",
                    providers[index + 1].label,
                )
                continue
            break

    msg = str(last_exc) if last_exc else "unknown error"
    raise LlmJsonCompletionError(msg, last_status=last_status) from last_exc


async def complete_json_async(
    prompt: str,
    *,
    settings: Settings | None = None,
    timeout_seconds: float | None = None,
) -> tuple[dict[str, Any], str]:
    """Async variant for JD parse route."""
    s = settings or get_settings()
    providers = build_parse_providers(s)
    if not providers:
        raise LlmJsonCompletionError("No LLM API keys configured for parsing.")

    allow_backup = bool(s.ai_parse_enable_backup)
    last_exc: BaseException | None = None
    last_status: int | None = None

    for index, provider in enumerate(providers):
        if timeout_seconds is not None:
            provider = _Provider(
                label=provider.label,
                api_key=provider.api_key,
                api_base=provider.api_base,
                model=provider.model,
                timeout_seconds=timeout_seconds,
                version_tag=provider.version_tag,
            )
        try:
            payload = await _request_async(provider, prompt)
            if index > 0:
                logger.warning(
                    "llm_json_completion.fallback_success primary_failed=true provider=%s",
                    provider.label,
                )
            return payload, provider.version_tag
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if isinstance(exc, httpx.HTTPStatusError):
                last_status = exc.response.status_code
            logger.warning(
                "llm_json_completion.provider_failed provider=%s error=%s",
                provider.label,
                exc,
            )
            if index + 1 < len(providers) and _should_try_next(exc, allow_backup=allow_backup):
                logger.warning(
                    "llm_json_completion.trying_backup next=%s",
                    providers[index + 1].label,
                )
                continue
            break

    msg = str(last_exc) if last_exc else "unknown error"
    raise LlmJsonCompletionError(msg, last_status=last_status) from last_exc
