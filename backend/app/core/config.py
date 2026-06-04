import os
from functools import lru_cache
from pathlib import Path
import logging

from pydantic import AliasChoices, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from dotenv import load_dotenv
from app.core.paths import BACKEND_ROOT
from app.utils.redaction import redact_database_url


BASE_DIR = BACKEND_ROOT
ENV_FILE = BASE_DIR / ".env"
load_dotenv(dotenv_path=ENV_FILE)


class Settings(BaseSettings):
    app_name: str = "AIRIS Backend"
    app_env: str = "development"
    debug: bool = False

    # Supabase/PostgreSQL SQLAlchemy URL.
    # Example: postgresql+psycopg://postgres:password@host:5432/postgres
    database_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "DATABASE_URL",
            "database_url",
            "DB_URL",
            "SUPABASE_DB_URL",
            "SUPABASE_DATABASE_URL",
        ),
    )
    test_database_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("TEST_DATABASE_URL", "test_database_url"),
    )

    # Supabase REST URL (for API clients). This is NOT a SQLAlchemy DB URL.
    supabase_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("SUPABASE_URL", "supabase_url"),
    )

    # Optional target schema if you want to scope reflection and migrations.
    db_schema: str | None = None
    jwt_secret_key: str = Field(
        # SECURITY: override this with a cryptographically-random value in all
        # non-local environments. Generate one with:
        #   python -c "import secrets; print(secrets.token_hex(32))"
        # The startup validator below raises if this default survives to production.
        default="change-me-in-production",
        validation_alias=AliasChoices("JWT_SECRET_KEY", "jwt_secret_key"),
    )
    jwt_algorithm: str = Field(default="HS256", validation_alias=AliasChoices("JWT_ALGORITHM", "jwt_algorithm"))
    jwt_access_token_exp_minutes: int = Field(
        default=60,
        validation_alias=AliasChoices("JWT_ACCESS_TOKEN_EXP_MINUTES", "jwt_access_token_exp_minutes"),
    )
    jwt_refresh_token_exp_days: int = Field(
        default=7,
        validation_alias=AliasChoices("JWT_REFRESH_TOKEN_EXP_DAYS", "jwt_refresh_token_exp_days"),
    )
    jwt_max_concurrent_sessions_default: int = Field(
        default=5,
        validation_alias=AliasChoices(
            "JWT_MAX_CONCURRENT_SESSIONS_DEFAULT",
            "jwt_max_concurrent_sessions_default",
        ),
    )
    cors_origins: str = Field(
        default=(
            # Production (Vercel):
            "https://airis-sample1.vercel.app,"
            # Local dev:
            "http://localhost:3000,http://127.0.0.1:3000,"
            "http://localhost:3001,http://127.0.0.1:3001,"
            "http://localhost:3002,http://127.0.0.1:3002"
        ),
        validation_alias=AliasChoices("CORS_ORIGINS", "cors_origins"),
    )

    # Frontend base URL for invite links (no trailing slash required).
    frontend_url: str = Field(
        default="http://localhost:3000",
        validation_alias=AliasChoices("FRONTEND_URL", "frontend_url"),
    )

    # Brevo SMTP (https://developers.brevo.com/docs/send-transactional-emails-using-smtp-relay)
    smtp_host: str = Field(
        default="smtp-relay.brevo.com",
        validation_alias=AliasChoices("SMTP_HOST", "smtp_host"),
    )
    smtp_port: int = Field(default=587, validation_alias=AliasChoices("SMTP_PORT", "smtp_port"))
    smtp_user: str | None = Field(default=None, validation_alias=AliasChoices("SMTP_USER", "smtp_user"))
    smtp_password: str | None = Field(
        default=None,
        validation_alias=AliasChoices("SMTP_PASSWORD", "smtp_password"),
    )
    smtp_from: str | None = Field(
        default=None,
        validation_alias=AliasChoices("SMTP_FROM", "smtp_from"),
    )

    google_client_id: str | None = Field(default=None, validation_alias=AliasChoices("GOOGLE_CLIENT_ID", "google_client_id"))
    google_client_secret: str | None = Field(
        default=None, validation_alias=AliasChoices("GOOGLE_CLIENT_SECRET", "google_client_secret")
    )
    google_redirect_uri: str | None = Field(
        default=None, validation_alias=AliasChoices("GOOGLE_REDIRECT_URI", "google_redirect_uri")
    )
    ms_client_id: str | None = Field(default=None, validation_alias=AliasChoices("MS_CLIENT_ID", "ms_client_id"))
    ms_client_secret: str | None = Field(
        default=None, validation_alias=AliasChoices("MS_CLIENT_SECRET", "ms_client_secret")
    )
    ms_redirect_uri: str | None = Field(
        default=None, validation_alias=AliasChoices("MS_REDIRECT_URI", "ms_redirect_uri")
    )
    ms_tenant_id: str = Field(default="common", validation_alias=AliasChoices("MS_TENANT_ID", "ms_tenant_id"))
    comm_token_encryption_key: str | None = Field(
        default=None, validation_alias=AliasChoices("COMM_TOKEN_ENCRYPTION_KEY", "comm_token_encryption_key")
    )
    comm_oauth_state_secret: str | None = Field(
        default=None, validation_alias=AliasChoices("COMM_OAUTH_STATE_SECRET", "comm_oauth_state_secret")
    )
    twilio_account_sid: str | None = Field(
        default=None, validation_alias=AliasChoices("TWILIO_ACCOUNT_SID", "twilio_account_sid")
    )
    twilio_auth_token: str | None = Field(
        default=None, validation_alias=AliasChoices("TWILIO_AUTH_TOKEN", "twilio_auth_token")
    )
    twilio_whatsapp_number: str | None = Field(
        default=None, validation_alias=AliasChoices("TWILIO_WHATSAPP_NUMBER", "twilio_whatsapp_number")
    )

    # Groq API key — primary for resume/JD parsing.
    groq_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("GROQ_API_KEY", "groq_api_key"),
    )
    # Second Groq key — backup when primary fails (resume/JD parse only).
    groq_api_key_backup: str | None = Field(
        default=None,
        validation_alias=AliasChoices("GROQ_API_KEY_BACKUP", "groq_api_key_backup"),
    )
    # Resume/JD parse: try backup Groq (then Grok) when primary Groq fails.
    ai_parse_enable_backup: bool = Field(
        default=True,
        validation_alias=AliasChoices("AI_PARSE_ENABLE_BACKUP", "ai_parse_enable_backup"),
    )

    # Groq API key for AI Screening Interview (live conversational interviews).
    groq_api_key_aiinterview: str | None = Field(
        default=None,
        validation_alias=AliasChoices("GROQ_API_KEY_AIinterview", "groq_api_key_aiinterview"),
    )
    groq_aiinterview_model: str = Field(
        default="llama-3.3-70b-versatile",
        validation_alias=AliasChoices("GROQ_AIINTERVIEW_MODEL", "groq_aiinterview_model"),
    )
    groq_aiinterview_api_base: str = Field(
        default="https://api.groq.com/openai/v1",
        validation_alias=AliasChoices("GROQ_AIINTERVIEW_API_BASE", "groq_aiinterview_api_base"),
    )
    groq_aiinterview_timeout_seconds: float = Field(
        default=30.0,
        validation_alias=AliasChoices("GROQ_AIINTERVIEW_TIMEOUT_SECONDS", "groq_aiinterview_timeout_seconds"),
    )

    # Groq API key for ATS semantic enrichment (OpenAI-compatible API).
    groq_ats_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("GROQ_API_KEY_ATS", "groq_ats_api_key"),
    )
    groq_ats_api_base: str = Field(
        default="https://api.groq.com/openai/v1",
        validation_alias=AliasChoices("GROQ_ATS_API_BASE", "groq_ats_api_base"),
    )
    groq_ats_model: str = Field(
        default="llama-3.3-70b-versatile",
        validation_alias=AliasChoices("GROQ_ATS_MODEL", "groq_ats_model"),
    )
    groq_ats_timeout_seconds: float = Field(
        default=10.0,
        validation_alias=AliasChoices("GROQ_ATS_TIMEOUT_SECONDS", "groq_ats_timeout_seconds"),
    )

    # xAI Grok — hybrid ATS semantic enrichment (OpenAI-compatible API).
    grok_api_key: str | None = Field(
        default=None,
        # Support older/mistyped env var names used in some deployments.
        validation_alias=AliasChoices(
            "GROK_API_KEY",
            "GROK_API_KEY_ATS",
            "GROQ_API_KEY_ATS",
            "grok_api_key",
            "XAI_API_KEY",
            "xai_api_key",
        ),
    )
    grok_api_base: str = Field(
        default="https://api.x.ai/v1",
        validation_alias=AliasChoices("GROK_API_BASE", "grok_api_base"),
    )
    grok_model: str = Field(
        # xAI model IDs change over time; use a conservative default that exists
        # on current accounts, and allow override via env.
        default="grok-3-mini",
        validation_alias=AliasChoices("GROK_MODEL", "grok_model"),
    )
    grok_timeout_seconds: float = Field(
        default=10.0,
        validation_alias=AliasChoices("GROK_TIMEOUT_SECONDS", "grok_timeout_seconds"),
    )
    # Optional Grok pass after local resume extraction (adds latency on upload/parse).
    resume_grok_intelligence: bool = Field(
        default=False,
        validation_alias=AliasChoices("RESUME_GROK_INTELLIGENCE", "resume_grok_intelligence"),
    )

    # OpenAI — AI Screening layer (GPT-4.1-mini)
    openai_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("OPENAI_API_KEY", "openai_api_key"),
    )
    openai_api_base: str = Field(
        default="https://api.openai.com/v1",
        validation_alias=AliasChoices("OPENAI_API_BASE", "openai_api_base"),
    )
    openai_screening_model: str = Field(
        default="gpt-4.1-mini",
        validation_alias=AliasChoices("OPENAI_SCREENING_MODEL", "openai_screening_model"),
    )
    openai_timeout_seconds: float = Field(
        default=60.0,
        validation_alias=AliasChoices("OPENAI_TIMEOUT_SECONDS", "openai_timeout_seconds"),
    )

    # ── LiveKit embedded video conferencing ──────────────────────────────────
    # LiveKit Cloud: https://cloud.livekit.io  (free tier available)
    # Self-hosted:   set LIVEKIT_WS_URL to wss://your-server
    livekit_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("LIVEKIT_API_KEY", "livekit_api_key"),
    )
    livekit_api_secret: str | None = Field(
        default=None,
        validation_alias=AliasChoices("LIVEKIT_API_SECRET", "livekit_api_secret"),
    )
    # WebSocket URL for the LiveKit server, e.g. wss://your-project.livekit.cloud
    # Accepts both LIVEKIT_WS_URL (canonical) and LIVEKIT_URL (common shorthand).
    livekit_ws_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "LIVEKIT_WS_URL",
            "LIVEKIT_URL",
            "livekit_ws_url",
            "livekit_url",
        ),
    )

    # AI Interview Copilot feature flag and settings
    copilot_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("COPILOT_ENABLED", "copilot_enabled"),
    )
    copilot_model: str = Field(
        default="gpt-4.1-mini",
        validation_alias=AliasChoices("COPILOT_MODEL", "copilot_model"),
    )
    assemblyai_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("ASSEMBLYAI_API_KEY", "assemblyai_api_key"),
    )

    # ── Transcription provider selection ────────────────────────────────────────
    # Controls which backend is used for the /copilot/transcribe-audio endpoint.
    # "whisper"  (default) — OpenAI Whisper; requires OPENAI_API_KEY.
    # Future values: "assemblyai-batch", "deepgram", etc.
    transcription_provider: str = Field(
        default="whisper",
        validation_alias=AliasChoices("TRANSCRIPTION_PROVIDER", "transcription_provider"),
    )

    # ── Celery / Redis (INFRA-006) ────────────────────────────────────────────
    celery_broker_url: str = Field(
        default="redis://localhost:6379/0",
        validation_alias=AliasChoices("CELERY_BROKER_URL", "celery_broker_url"),
    )
    celery_result_backend: str = Field(
        default="redis://localhost:6379/1",
        validation_alias=AliasChoices("CELERY_RESULT_BACKEND", "celery_result_backend"),
    )
    # Set to "true" to route tasks through Celery workers instead of the
    # in-process ThreadPoolExecutor fallback. Keep false in dev without Redis.
    celery_dispatch_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices("CELERY_DISPATCH_ENABLED", "celery_dispatch_enabled"),
    )

    # ── API Documentation ─────────────────────────────────────────────────────
    # Override default env-based docs visibility.
    # True  → always serve /docs and /redoc.
    # False → always disable /docs and /redoc.
    # None  → auto: enabled in development/staging, disabled in production.
    docs_enabled: bool | None = Field(
        default=None,
        validation_alias=AliasChoices("DOCS_ENABLED", "docs_enabled"),
    )

    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @model_validator(mode="after")
    def validate_jwt_secret(self) -> "Settings":
        _INSECURE_DEFAULT = "change-me-in-production"
        if self.jwt_secret_key == _INSECURE_DEFAULT:
            env = self.app_env.lower()
            if env in ("production", "staging", "prod", "stage"):
                raise ValueError(
                    "JWT_SECRET_KEY must be set to a secure random value in production/staging. "
                    "Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\""
                )
            import logging as _logging
            _logging.getLogger(__name__).warning(
                "JWT_SECRET_KEY is using the insecure default value. "
                "Set JWT_SECRET_KEY in your .env file before deploying."
            )
        return self

    @model_validator(mode="after")
    def validate_database_config(self) -> "Settings":
        if self.database_url:
            if self.database_url.startswith("postgresql://"):
                # Default "postgresql://" makes SQLAlchemy try psycopg2.
                # This project uses psycopg (v3), so normalize the URL automatically.
                self.database_url = self.database_url.replace(
                    "postgresql://",
                    "postgresql+psycopg://",
                    1,
                )

            # Session-mode pooler (port 5432) + NullPool is the correct setup.
            # NullPool (set in db/session.py for all Supabase URLs) opens and
            # immediately closes every connection, so pgBouncer's session-mode
            # accounting stays accurate and transaction-mode is not needed.
            # We deliberately do NOT rewrite 5432→6543: the transaction-mode pool
            # (6543) saturates under modest concurrent load because pgBouncer
            # queues waiting clients rather than refusing them, leading to 60-second
            # ECHECKOUTTIMEOUT errors on all endpoints.

            return self

        if self.supabase_url:
            raise ValueError(
                "DATABASE_URL is required for backend DB access. "
                "You currently provided SUPABASE_URL/supabase_url (REST URL), which cannot be used by SQLAlchemy/Alembic. "
                "Set DATABASE_URL (or SUPABASE_DB_URL) to your Postgres connection string."
            )

        raise ValueError(
            "DATABASE_URL is required. Set DATABASE_URL (or SUPABASE_DB_URL) in backend/.env."
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()
    logger = logging.getLogger(__name__)
    logger.debug(
        "Settings loaded with database URL configured: %s",
        redact_database_url(settings.database_url or ""),
    )
    return settings


def get_cors_origins(raw_origins: str) -> list[str]:
    return [origin.strip() for origin in raw_origins.split(",") if origin.strip()]

