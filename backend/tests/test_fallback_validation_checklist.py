"""
SAFE FALLBACK VALIDATION CHECKLIST — automated coverage.
Run: pytest tests/test_fallback_validation_checklist.py -v -s
"""
from __future__ import annotations

import json
import os
import time
from unittest.mock import MagicMock, patch

import httpx
import pytest

from app.core.config import Settings, get_settings
from app.services.llm_json_completion import (
    LlmJsonCompletionError,
    build_parse_providers,
    complete_json_async,
    complete_json_sync,
)


def _live_settings(**overrides: object) -> Settings:
    s = get_settings()
    return Settings.model_construct(
        groq_api_key=overrides.get("groq_api_key", s.groq_api_key),
        groq_api_key_backup=overrides.get("groq_api_key_backup", s.groq_api_key_backup),
        groq_ats_api_key=s.groq_ats_api_key,
        grok_api_key=s.grok_api_key,
        ai_parse_enable_backup=overrides.get("ai_parse_enable_backup", s.ai_parse_enable_backup),
        groq_ats_api_base=s.groq_ats_api_base,
        groq_ats_model=s.groq_ats_model,
        groq_ats_timeout_seconds=s.groq_ats_timeout_seconds,
        grok_api_base=s.grok_api_base,
        grok_model=s.grok_model,
        grok_timeout_seconds=s.grok_timeout_seconds,
    )


RESUME_PROMPT_SNIPPET = "first_name"
JD_PROMPT_SNIPPET = "title"


@pytest.fixture
def backup_key() -> str | None:
    return os.getenv("GROQ_API_KEY_BACKUP") or None


class TestPreChecks:
    def test_backup_flag_enabled(self) -> None:
        s = get_settings()
        assert s.ai_parse_enable_backup is True

    def test_backup_key_configured(self, backup_key: str | None) -> None:
        assert backup_key and len(backup_key) > 20, "Set GROQ_API_KEY_BACKUP in backend/.env"


class TestStep1ForcePrimaryFailure:
    @pytest.mark.integration
    def test_invalid_primary_uses_backup(self, backup_key: str | None) -> None:
        if not backup_key:
            pytest.skip("GROQ_API_KEY_BACKUP not set")
        settings = _live_settings(
            groq_api_key="INVALID_TEST_KEY_DO_NOT_USE",
            groq_api_key_backup=backup_key,
            ai_parse_enable_backup=True,
        )
        prompt = (
            'Return ONLY JSON: {"parsed_resume_data":{"first_name":"Test","last_name":"User"},'
            '"extracted_skills":[],"parse_confidence":0.9}'
        )
        with patch("app.services.llm_json_completion.get_settings", return_value=settings):
            payload, tag = complete_json_sync(prompt, settings=settings)
        assert "first_name" in json.dumps(payload).lower() or payload
        assert "backup" in tag or tag.startswith("groq-backup")


class TestStep2ResumeParsing:
    @pytest.mark.integration
    def test_resume_adapter_schema_stable(self, backup_key: str | None) -> None:
        if not backup_key:
            pytest.skip("GROQ_API_KEY_BACKUP not set")
        from app.candidate_management.ai_adapter import HttpAIService

        settings = _live_settings(
            groq_api_key="INVALID_TEST_KEY_DO_NOT_USE",
            groq_api_key_backup=backup_key,
        )
        sample = (
            "Jane Doe\nSoftware Engineer\njane@example.com\n+1 555-0100\n"
            "Skills: Python, FastAPI, PostgreSQL\n5 years experience"
        )
        with patch("app.candidate_management.ai_adapter.get_settings", return_value=settings):
            with patch("app.services.llm_json_completion.get_settings", return_value=settings):
                with patch.object(HttpAIService, "_extract_text", return_value=sample):
                    svc = HttpAIService()
                    result = svc._parse_with_groq("resumes/test/resume.pdf")

        assert "parsed_resume_data" in result
        assert "extracted_skills" in result
        assert result.get("ai_parse_version")


class TestStep3JdParsing:
    @pytest.mark.integration
    def test_jd_parse_with_backup(self, backup_key: str | None) -> None:
        import anyio
        if not backup_key:
            pytest.skip("GROQ_API_KEY_BACKUP not set")
        from app.routes.job import _jd_parse_prompt

        settings = _live_settings(
            groq_api_key="INVALID_TEST_KEY_DO_NOT_USE",
            groq_api_key_backup=backup_key,
        )
        text = "Senior Python Developer. Full time. Bangalore. 5+ years. Python, Django required."
        async def _run() -> tuple[dict, str]:
            with patch("app.services.llm_json_completion.get_settings", return_value=settings):
                return await complete_json_async(_jd_parse_prompt(text), settings=settings)

        parsed, tag = anyio.run(_run)
        assert isinstance(parsed, dict)
        assert "backup" in tag or "title" in parsed or parsed.get("title")


class TestStep4Logs:
    def test_fallback_logs_on_primary_503(self, caplog: pytest.LogCaptureFixture) -> None:
        import logging

        caplog.set_level(logging.WARNING, logger="app.services.llm_json_completion")
        settings = Settings.model_construct(
            groq_api_key="key1",
            groq_api_key_backup="key2",
            groq_ats_api_key=None,
            grok_api_key=None,
            ai_parse_enable_backup=True,
            groq_ats_timeout_seconds=10.0,
            grok_timeout_seconds=10.0,
        )
        err_resp = MagicMock(status_code=503)
        err = httpx.HTTPStatusError("fail", request=MagicMock(), response=err_resp)
        ok = MagicMock()
        ok.json.return_value = {
            "choices": [{"message": {"content": '{"title":"Engineer"}'}}],
        }
        ok.raise_for_status = MagicMock()

        with patch("app.services.llm_json_completion.httpx.Client") as client_cls:
            client = MagicMock()
            client_cls.return_value.__enter__.return_value = client
            client.post.side_effect = [err, ok]
            complete_json_sync("prompt", settings=settings)

        joined = caplog.text
        assert "provider_failed" in joined and "groq" in joined
        assert "trying_backup" in joined and "groq-backup" in joined
        assert "fallback_success" in joined


class TestStep6LocalFallback:
    def test_resume_local_when_all_llm_fail(self) -> None:
        from app.candidate_management.ai_adapter import HttpAIService

        settings = Settings.model_construct(
            groq_api_key="bad",
            groq_api_key_backup="bad",
            groq_ats_api_key=None,
            grok_api_key=None,
            ai_parse_enable_backup=True,
            groq_ats_timeout_seconds=10.0,
            grok_timeout_seconds=10.0,
        )
        text = "John Smith\njohn@test.com\nPython developer\n3 years"
        with patch("app.candidate_management.ai_adapter.get_settings", return_value=settings):
            with patch("app.services.llm_json_completion.get_settings", return_value=settings):
                with patch.object(HttpAIService, "_extract_text", return_value=text):
                    with patch(
                        "app.services.llm_json_completion._request_sync",
                        side_effect=LlmJsonCompletionError("all failed"),
                    ):
                        svc = HttpAIService()
                        result = svc._parse_with_groq("resumes/x/y.pdf")

        assert result.get("parsed_resume_data")
        assert result.get("ai_parse_version") == "local-fallback-v1"

    def test_jd_clean_error_when_all_fail(self) -> None:
        import anyio

        settings = Settings.model_construct(
            groq_api_key="bad",
            groq_api_key_backup="bad",
            groq_ats_api_key=None,
            grok_api_key=None,
            ai_parse_enable_backup=True,
            groq_ats_timeout_seconds=10.0,
            grok_timeout_seconds=10.0,
        )

        async def _run() -> None:
            with patch("app.services.llm_json_completion.get_settings", return_value=settings):
                with pytest.raises(LlmJsonCompletionError):
                    await complete_json_async('Return JSON: {"title":"x"}', settings=settings)

        anyio.run(_run)


class TestStep7FeatureFlagRollback:
    def test_no_backup_when_disabled(self) -> None:
        settings = Settings.model_construct(
            groq_api_key="key1",
            groq_api_key_backup="key2",
            groq_ats_api_key=None,
            grok_api_key=None,
            ai_parse_enable_backup=False,
            groq_ats_timeout_seconds=10.0,
            grok_timeout_seconds=10.0,
        )
        err_resp = MagicMock(status_code=503)
        err = httpx.HTTPStatusError("fail", request=MagicMock(), response=err_resp)

        with patch("app.services.llm_json_completion.httpx.Client") as client_cls:
            client = MagicMock()
            client_cls.return_value.__enter__.return_value = client
            client.post.side_effect = err
            with pytest.raises(LlmJsonCompletionError):
                complete_json_sync("prompt", settings=settings)
        assert client.post.call_count == 1


class TestStep8Performance:
    def test_no_retry_loop_on_failure(self) -> None:
        settings = Settings.model_construct(
            groq_api_key="key1",
            groq_api_key_backup="key2",
            groq_ats_api_key=None,
            grok_api_key=None,
            ai_parse_enable_backup=True,
            groq_ats_timeout_seconds=10.0,
            grok_timeout_seconds=10.0,
        )
        err_resp = MagicMock(status_code=503)
        err = httpx.HTTPStatusError("fail", request=MagicMock(), response=err_resp)

        with patch("app.services.llm_json_completion.httpx.Client") as client_cls:
            client = MagicMock()
            client_cls.return_value.__enter__.return_value = client
            client.post.side_effect = [err, err]
            t0 = time.monotonic()
            with pytest.raises(LlmJsonCompletionError):
                complete_json_sync("prompt", settings=settings)
            elapsed = time.monotonic() - t0

        assert client.post.call_count == 2
        assert elapsed < 5.0

    def test_provider_chain_length_bounded(self) -> None:
        s = get_settings()
        assert len(build_parse_providers(s)) <= 3
