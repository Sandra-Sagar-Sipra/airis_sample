"""F-INV-04 — Invite Email Delivery System tests.

Acceptance criteria verified:
  AC1  Email triggered on invite create (POST /invites).
  AC2  Email triggered on invite resend (POST /invites/{id}/resend).
  AC3  Email contains valid invite link (token, frontend URL, role, expiry).
  AC4  Delivery receipt confirmed — delivery_status updated after send.
  AC5  Failed delivery logged with error; delivery_status set to 'failed'.
  AC6  SMTP credentials checked before attempting send.
  AC7  send_invite_email returns message_id and provider.
  AC8  Delivery tracking fields present on InviteResponse.
  AC9  SMTP diagnostic endpoint reachable (GET /invites/smtp-check).
  AC10 Retry logic: Celery task retries up to max_retries on SMTP failure.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, call, patch
from uuid import UUID, uuid4

import pytest

pytestmark = pytest.mark.unit

# ── shared fixtures ────────────────────────────────────────────────────────────

_ORG_ID   = UUID("dddddddd-0000-0000-0000-000000000001")
_ADMIN_ID = UUID("dddddddd-0000-0000-0000-000000000002")
_INV_ID   = UUID("dddddddd-0000-0000-0000-000000000010")
_NOW      = datetime(2026, 6, 1, 9, 0, 0, tzinfo=UTC)
_FUTURE   = _NOW + timedelta(days=7)

_SMTP_SETTINGS = dict(
    smtp_host="smtp-relay.brevo.com",
    smtp_port=587,
    smtp_user="test@brevo.com",
    smtp_password="secret",
    smtp_from="noreply@airis.app",
    frontend_url="http://localhost:3000",
)


def _make_settings(**overrides):
    s = MagicMock()
    for k, v in {**_SMTP_SETTINGS, **overrides}.items():
        setattr(s, k, v)
    return s


# ── AC1 / AC2: email triggered on create and resend ──────────────────────────


def test_ac1_email_dispatched_on_create() -> None:
    """dispatch_task is called with correct kwargs when creating an invite."""
    from unittest.mock import patch
    from app.services.email_service import send_invite_email_background
    from app.tasks.email_tasks import send_invite_email_task

    with (
        patch("app.routes.invites.dispatch_task") as mock_dispatch,
        patch("app.routes.invites.get_role_id_by_key", return_value=uuid4()),
        patch("app.routes.invites._now_utc", return_value=_NOW),
    ):
        import app.main as main_module
        from app.core.dependencies import get_current_user
        from app.db.session import get_db
        from app.schemas.auth import CurrentUser
        from fastapi.testclient import TestClient

        db = MagicMock()
        db.scalar.return_value = None  # no profile, no active invite

        from app.models.invite import Invite as RealInvite

        def _refresh(obj):
            if isinstance(obj, RealInvite) and obj.id is None:
                obj.id = _INV_ID
            if isinstance(obj, RealInvite) and obj.created_at is None:
                obj.created_at = _NOW

        db.refresh = _refresh

        def _admin():
            return CurrentUser(user_id=str(_ADMIN_ID), organization_id=str(_ORG_ID), role="admin")

        app = main_module.app
        app.dependency_overrides[get_current_user] = _admin
        app.dependency_overrides[get_db] = lambda: db

        try:
            with TestClient(app, raise_server_exceptions=True) as client:
                resp = client.post(
                    "/api/v1/invites",
                    json={"email": "new@example.com", "role": "recruiter", "expires_in_days": 7},
                )
        finally:
            app.dependency_overrides.clear()

    assert resp.status_code == 201, resp.text
    mock_dispatch.assert_called_once()
    call_kwargs = mock_dispatch.call_args
    assert call_kwargs.kwargs["task"] is send_invite_email_task
    assert call_kwargs.kwargs["fallback"] is send_invite_email_background
    sent_kwargs = call_kwargs.kwargs["kwargs"]
    assert sent_kwargs["to_email"] == "new@example.com"
    assert sent_kwargs["role"] == "recruiter"
    assert "token" in sent_kwargs
    assert "expires_at_iso" in sent_kwargs
    assert "invite_id" in sent_kwargs


def test_ac2_email_dispatched_on_resend() -> None:
    """dispatch_task is called when resending an invite."""
    import app.main as main_module
    from app.core.dependencies import get_current_user
    from app.db.session import get_db
    from app.models.invite import (
        INVITE_STATUS_SENT,
        Invite as RealInvite,
    )
    from app.schemas.auth import CurrentUser
    from fastapi.testclient import TestClient
    from unittest.mock import MagicMock, patch

    invite = MagicMock(spec=RealInvite)
    invite.id = _INV_ID
    invite.email = "user@example.com"
    invite.organization_id = _ORG_ID
    invite.role = "recruiter"
    invite.token = "existing-token"
    invite.status = INVITE_STATUS_SENT
    invite.expires_at = _FUTURE

    db = MagicMock()
    db.scalar.return_value = invite
    db.refresh = lambda _: None

    def _admin():
        return CurrentUser(user_id=str(_ADMIN_ID), organization_id=str(_ORG_ID), role="admin")

    app = main_module.app
    app.dependency_overrides[get_current_user] = _admin
    app.dependency_overrides[get_db] = lambda: db

    try:
        with (
            patch("app.routes.invites.dispatch_task") as mock_dispatch,
            patch("app.routes.invites._now_utc", return_value=_NOW),
        ):
            with TestClient(app, raise_server_exceptions=True) as client:
                resp = client.post(f"/api/v1/invites/{_INV_ID}/resend")
    finally:
        app.dependency_overrides.clear()

    assert resp.status_code == 200, resp.text
    mock_dispatch.assert_called_once()
    sent_kwargs = mock_dispatch.call_args.kwargs["kwargs"]
    assert sent_kwargs["to_email"] == "user@example.com"
    assert sent_kwargs["role"] == "recruiter"
    assert "invite_id" in sent_kwargs


# ── AC3: email contains valid link, role, expiry ──────────────────────────────


def test_ac3_invite_link_contains_token_and_frontend_url() -> None:
    """The invite link is built from FRONTEND_URL and the token."""
    from app.services.email_service import _invite_link

    with patch("app.services.email_service.get_settings", return_value=_make_settings()):
        link = _invite_link("my-secret-token")

    assert link.startswith("http://localhost:3000")
    assert "my-secret-token" in link
    assert "/invite/accept" in link


def test_ac3_email_body_contains_role_and_expiry() -> None:
    """HTML and plain bodies include the role display name and expiry."""
    from app.services.email_service import _html_body, _plain_body

    expires_at = datetime(2026, 6, 8, tzinfo=UTC)
    html = _html_body("http://test/link", "recruiter", expires_at)
    plain = _plain_body("http://test/link", "recruiter", expires_at)

    assert "Recruiter" in html
    assert "http://test/link" in html
    assert "expires" in html.lower()

    assert "Recruiter" in plain
    assert "http://test/link" in plain
    assert "expires" in plain.lower()


def test_ac3_role_display_formats_correctly() -> None:
    from app.services.email_service import _role_display

    assert _role_display("recruiter") == "Recruiter"
    assert _role_display("client_viewer") == "Client Viewer"
    assert _role_display(None) == "team member"


# ── AC4: delivery receipt — delivery_status updated after send ────────────────


def test_ac4_delivery_status_updated_on_success() -> None:
    """update_invite_delivery_status executes UPDATE with status='sent'."""
    from app.services.email_service import update_invite_delivery_status

    db = MagicMock()

    # SessionLocal is imported lazily inside the function — patch the module it comes from
    with patch("app.db.session.SessionLocal", return_value=db):
        update_invite_delivery_status(
            str(_INV_ID),
            status="sent",
            message_id="<abc@airis.invite>",
            provider="brevo_smtp",
        )

    db.execute.assert_called_once()
    db.commit.assert_called_once()
    db.close.assert_called_once()


def test_ac4_send_invite_email_returns_message_id() -> None:
    """send_invite_email returns {'message_id': ..., 'provider': 'brevo_smtp'}."""
    from app.services.email_service import send_invite_email

    mock_smtp = MagicMock()
    mock_smtp.__enter__ = lambda s: s
    mock_smtp.__exit__ = MagicMock(return_value=False)
    mock_smtp.send_message.return_value = {}   # no refused recipients

    with (
        patch("app.services.email_service.get_settings", return_value=_make_settings()),
        patch("app.services.email_service.smtplib.SMTP", return_value=mock_smtp),
    ):
        result = send_invite_email(
            "recipient@example.com",
            "tok123",
            role="recruiter",
            expires_at=_FUTURE,
        )

    assert "message_id" in result
    assert result["message_id"].startswith("<")
    assert result["provider"] == "brevo_smtp"

    # Verify Message-ID header was set in the actual email
    send_call = mock_smtp.send_message.call_args[0][0]
    assert send_call["Message-ID"] == result["message_id"]


def test_ac4_delivery_fields_in_invite_response() -> None:
    """InviteResponse schema exposes all six delivery tracking fields."""
    from app.schemas.invite import InviteResponse

    resp = InviteResponse(
        id=str(_INV_ID),
        email="a@b.com",
        organization_id=str(_ORG_ID),
        role="recruiter",
        status="sent",
        expires_at=_FUTURE,
        created_at=_NOW,
        delivery_status="sent",
        delivery_provider="brevo_smtp",
        message_id="<abc123@airis.invite>",
        delivery_attempts=1,
        last_delivery_attempt_at=_NOW,
        last_delivery_error=None,
    )

    assert resp.delivery_status == "sent"
    assert resp.delivery_provider == "brevo_smtp"
    assert resp.message_id == "<abc123@airis.invite>"
    assert resp.delivery_attempts == 1


# ── AC5: failed delivery logged, delivery_status = 'failed' ──────────────────


def test_ac5_smtp_failure_raises_and_logs(caplog: pytest.LogCaptureFixture) -> None:
    """When SMTP fails, send_invite_email raises and logs the failure."""
    from app.services.email_service import send_invite_email

    mock_smtp = MagicMock()
    mock_smtp.__enter__ = lambda s: s
    mock_smtp.__exit__ = MagicMock(return_value=False)
    mock_smtp.starttls.side_effect = ConnectionRefusedError("Connection refused")

    with (
        patch("app.services.email_service.get_settings", return_value=_make_settings()),
        patch("app.services.email_service.smtplib.SMTP", return_value=mock_smtp),
        caplog.at_level(logging.ERROR, logger="app.services.email_service"),
    ):
        with pytest.raises(ConnectionRefusedError):
            send_invite_email("a@b.com", "token")

    assert any("invite_send_failed" in r.message or "invite_send_failed" in r.name
               for r in caplog.records)


def test_ac5_background_fallback_updates_failed_on_exception() -> None:
    """send_invite_email_background writes delivery_status='failed' on SMTP error."""
    from app.services.email_service import send_invite_email_background

    with (
        patch("app.services.email_service.send_invite_email", side_effect=RuntimeError("SMTP down")),
        patch("app.services.email_service.update_invite_delivery_status") as mock_update,
    ):
        with pytest.raises(RuntimeError):
            send_invite_email_background(
                "a@b.com", "tok", invite_id=str(_INV_ID)
            )

    mock_update.assert_called_once_with(
        str(_INV_ID),
        status="failed",
        error="SMTP down",
    )


# ── AC6: missing SMTP credentials raises clearly ─────────────────────────────


@pytest.mark.parametrize("missing_field", ["smtp_user", "smtp_password", "smtp_from"])
def test_ac6_missing_smtp_credential_raises(missing_field: str) -> None:
    """RuntimeError raised with a clear message when SMTP creds are incomplete."""
    from app.services.email_service import send_invite_email

    bad_settings = _make_settings(**{missing_field: None})
    with (
        patch("app.services.email_service.get_settings", return_value=bad_settings),
        pytest.raises(RuntimeError),
    ):
        send_invite_email("a@b.com", "tok")


# ── AC7: message_id set in email and returned ─────────────────────────────────


def test_ac7_message_id_is_unique_per_call() -> None:
    """Each send_invite_email call generates a distinct Message-ID."""
    from app.services.email_service import send_invite_email

    mock_smtp = MagicMock()
    mock_smtp.__enter__ = lambda s: s
    mock_smtp.__exit__ = MagicMock(return_value=False)
    mock_smtp.send_message.return_value = {}

    with (
        patch("app.services.email_service.get_settings", return_value=_make_settings()),
        patch("app.services.email_service.smtplib.SMTP", return_value=mock_smtp),
    ):
        r1 = send_invite_email("a@b.com", "tok1")
        r2 = send_invite_email("b@b.com", "tok2")

    assert r1["message_id"] != r2["message_id"]


# ── AC8: delivery fields in list response ────────────────────────────────────


def test_ac8_list_item_has_delivery_fields() -> None:
    from app.schemas.invite import InviteListItem

    item = InviteListItem(
        id=str(_INV_ID),
        email="a@b.com",
        role="recruiter",
        status="sent",
        created_at=_NOW,
        expires_at=_FUTURE,
        delivery_status="sent",
        delivery_attempts=2,
        last_delivery_attempt_at=_NOW,
    )
    assert item.delivery_status == "sent"
    assert item.delivery_attempts == 2


# ── AC9: SMTP diagnostic endpoint ────────────────────────────────────────────


def test_ac9_smtp_check_endpoint_returns_200() -> None:
    """GET /invites/smtp-check is reachable and returns SmtpCheckResponse shape."""
    import app.main as main_module
    from app.core.dependencies import get_current_user
    from app.schemas.auth import CurrentUser
    from fastapi.testclient import TestClient

    def _admin():
        return CurrentUser(user_id=str(_ADMIN_ID), organization_id=str(_ORG_ID), role="admin")

    app = main_module.app
    app.dependency_overrides[get_current_user] = _admin

    mock_smtp = MagicMock()
    mock_smtp.__enter__ = lambda s: s
    mock_smtp.__exit__ = MagicMock(return_value=False)

    try:
        with (
            patch("app.routes.invites.smtplib.SMTP", return_value=mock_smtp),
            patch("app.services.email_service.get_settings", return_value=_make_settings()),
            TestClient(app, raise_server_exceptions=True) as client,
        ):
            resp = client.get("/api/v1/invites/smtp-check")
    finally:
        app.dependency_overrides.clear()

    assert resp.status_code == 200
    body = resp.json()
    assert "connected" in body
    assert "authenticated" in body
    assert "test_sent" in body
    assert "smtp_host" in body


# ── AC10: Celery task retry on SMTP failure ───────────────────────────────────


def test_ac10_celery_task_retry_configuration() -> None:
    """send_invite_email_task is registered with retry=3, exponential backoff, DLQ routing."""
    from app.tasks.email_tasks import send_invite_email_task

    # Verify retry parameters are set at task-registration time
    assert send_invite_email_task.max_retries == 3, "max_retries must be 3"
    assert send_invite_email_task.retry_backoff is True, "exponential backoff must be enabled"
    assert send_invite_email_task.retry_backoff_max == 120, "backoff cap must be 120 s"
    assert send_invite_email_task.retry_jitter is True, "jitter must be enabled (prevents thundering herd)"
    assert send_invite_email_task.queue == "email", "must route to email queue"


def test_ac10_task_calls_retry_on_smtp_error() -> None:
    """When SMTP raises, the task catches it and calls self.retry()."""
    from celery.exceptions import Retry

    from app.tasks.email_tasks import send_invite_email_task

    retry_mock = MagicMock(side_effect=Retry())
    mock_self = MagicMock()
    mock_self.request.retries = 0
    mock_self.retry = retry_mock

    with (
        patch("app.services.email_service.smtplib.SMTP", side_effect=RuntimeError("SMTP down")),
        patch("app.services.email_service.get_settings", return_value=_make_settings()),
        patch("app.services.email_service.update_invite_delivery_status"),
        pytest.raises(Retry),
    ):
        # Call the raw Celery-bound function by passing mock_self positionally
        # __wrapped__ on a bind=True task IS the original function with self as first param.
        # Don't pass task_instance separately — Celery already bound it.
        # Instead, bypass binding by calling the task's run() with retry patched:
        with patch.object(send_invite_email_task, "retry", retry_mock):
            send_invite_email_task.run(
                to_email="a@b.com",
                token="tok",
                invite_id=str(_INV_ID),
            )

    retry_mock.assert_called_once()
