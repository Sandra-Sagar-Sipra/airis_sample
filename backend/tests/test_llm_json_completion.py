"""Tests for Groq-first LLM JSON completion with provider fallback."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest

from app.core.config import Settings
from app.services.llm_json_completion import (
    LlmJsonCompletionError,
    build_parse_providers,
    complete_json_sync,
)


def _settings(
    *,
    groq: str | None = "groq-primary",
    groq_backup: str | None = None,
    grok: str | None = None,
    backup: bool = True,
) -> Settings:
    return Settings.model_construct(
        groq_api_key=groq,
        groq_api_key_backup=groq_backup,
        groq_ats_api_key=None,
        grok_api_key=grok,
        ai_parse_enable_backup=backup,
        groq_ats_api_base="https://api.groq.com/openai/v1",
        groq_ats_model="llama-3.3-70b-versatile",
        groq_ats_timeout_seconds=10.0,
        grok_api_base="https://api.x.ai/v1",
        grok_model="grok-3-mini",
        grok_timeout_seconds=10.0,
    )


def _mock_response(payload: dict) -> MagicMock:
    response = MagicMock()
    response.json.return_value = {
        "choices": [{"message": {"content": json.dumps(payload)}}],
    }
    response.raise_for_status = MagicMock()
    return response


def test_build_providers_dedupes_same_key() -> None:
    providers = build_parse_providers(_settings(groq="same", groq_backup="same"))
    assert len(providers) == 1
    assert providers[0].label == "groq"


def test_primary_503_backup_succeeds() -> None:
    settings = _settings(groq="key1", groq_backup="key2")
    primary_resp = MagicMock()
    primary_resp.status_code = 503
    primary_err = httpx.HTTPStatusError("fail", request=MagicMock(), response=primary_resp)

    backup_payload = {"title": "Engineer"}

    with patch("app.services.llm_json_completion.httpx.Client") as client_cls:
        client = MagicMock()
        client_cls.return_value.__enter__.return_value = client
        client.post.side_effect = [primary_err, _mock_response(backup_payload)]

        result, tag = complete_json_sync("prompt", settings=settings)

    assert result == backup_payload
    assert tag.startswith("groq-backup")
    assert client.post.call_count == 2


def test_401_tries_backup_when_enabled() -> None:
    settings = _settings(groq="key1", groq_backup="key2")
    primary_resp = MagicMock()
    primary_resp.status_code = 401
    primary_err = httpx.HTTPStatusError("unauthorized", request=MagicMock(), response=primary_resp)
    backup_payload = {"ok": True}

    with patch("app.services.llm_json_completion.httpx.Client") as client_cls:
        client = MagicMock()
        client_cls.return_value.__enter__.return_value = client
        client.post.side_effect = [primary_err, _mock_response(backup_payload)]

        result, tag = complete_json_sync("prompt", settings=settings)

    assert result == backup_payload
    assert "backup" in tag
    assert client.post.call_count == 2


def test_401_no_backup_when_disabled() -> None:
    settings = _settings(groq="key1", groq_backup="key2", backup=False)
    primary_resp = MagicMock()
    primary_resp.status_code = 401
    primary_err = httpx.HTTPStatusError("unauthorized", request=MagicMock(), response=primary_resp)

    with patch("app.services.llm_json_completion.httpx.Client") as client_cls:
        client = MagicMock()
        client_cls.return_value.__enter__.return_value = client
        client.post.side_effect = primary_err

        with pytest.raises(LlmJsonCompletionError):
            complete_json_sync("prompt", settings=settings)

    assert client.post.call_count == 1


def test_all_fail_raises() -> None:
    settings = _settings(groq="key1", groq_backup="key2")
    err_resp = MagicMock()
    err_resp.status_code = 503
    err = httpx.HTTPStatusError("fail", request=MagicMock(), response=err_resp)

    with patch("app.services.llm_json_completion.httpx.Client") as client_cls:
        client = MagicMock()
        client_cls.return_value.__enter__.return_value = client
        client.post.side_effect = [err, err]

        with pytest.raises(LlmJsonCompletionError):
            complete_json_sync("prompt", settings=settings)


def test_backup_disabled_single_provider() -> None:
    settings = _settings(groq="key1", groq_backup="key2", backup=False)
    err_resp = MagicMock()
    err_resp.status_code = 503
    err = httpx.HTTPStatusError("fail", request=MagicMock(), response=err_resp)

    with patch("app.services.llm_json_completion.httpx.Client") as client_cls:
        client = MagicMock()
        client_cls.return_value.__enter__.return_value = client
        client.post.side_effect = err

        with pytest.raises(LlmJsonCompletionError):
            complete_json_sync("prompt", settings=settings)

    assert client.post.call_count == 1


def test_resume_adapter_uses_backup_payload() -> None:
    from app.candidate_management.ai_adapter import HttpAIService

    payload = {
        "parsed_resume_data": {"first_name": "Ada", "last_name": "Lovelace"},
        "extracted_skills": [],
        "parse_confidence": 0.9,
    }

    with patch(
        "app.candidate_management.ai_adapter.complete_json_sync",
        return_value=(payload, "groq-backup-llama-3.3-70b-versatile"),
    ):
        with patch.object(HttpAIService, "_extract_text", return_value="resume text"):
            service = HttpAIService()
            result = service._parse_with_groq("resumes/org/id/file.pdf")

    assert result["ai_parse_version"] == "groq-backup-llama-3.3-70b-versatile"
    assert result["parsed_resume_data"]["first_name"] == "Ada"
