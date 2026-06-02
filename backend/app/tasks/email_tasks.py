"""F-INV-04 / INFRA-006 / AIR-233: Async email tasks.

Each task:
  - Accepts ``invite_id`` (optional) so it can write delivery tracking back
    to the invites table after the SMTP call completes.
  - Retries 3× with exponential backoff on transient failures.
  - Permanently-failed messages route to DLQ via the task_failure signal in
    celery_app.py.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from celery import Task
from celery.exceptions import MaxRetriesExceededError

from app.celery_app import QUEUE_EMAIL, celery_app

logger = logging.getLogger(__name__)


@celery_app.task(
    name="app.tasks.email_tasks.send_invite_email",
    bind=True,
    max_retries=3,
    retry_backoff=True,        # 10 s → 20 s → 40 s
    retry_backoff_max=120,
    retry_jitter=True,
    queue=QUEUE_EMAIL,
    time_limit=60,
)
def send_invite_email_task(
    self: Task,
    to_email: str,
    token: str,
    *,
    role: str | None = None,
    expires_at_iso: str | None = None,
    invite_id: str | None = None,
) -> dict[str, Any]:
    """Send an invite email asynchronously via Brevo SMTP.

    Args:
        to_email:       Recipient address.
        token:          Invite token — used to build the accept link.
        role:           Role slug for email body (e.g. ``recruiter``).
        expires_at_iso: ISO-8601 expiry timestamp for email body.
        invite_id:      UUID string; when present, delivery outcome is written
                        back to the invites table.
    """
    from app.services.email_service import send_invite_email, update_invite_delivery_status

    # Parse expiry for the email body
    expires_at: datetime | None = None
    if expires_at_iso:
        try:
            expires_at = datetime.fromisoformat(expires_at_iso)
        except ValueError:
            logger.warning(
                "email_tasks.invalid_expires_at_iso",
                extra={"invite_id": invite_id, "value": str(expires_at_iso)[:64]},
            )

    logger.info(
        "email_tasks.invite_send_attempt",
        extra={
            "to": to_email,
            "invite_id": invite_id or "unknown",
            "retry": self.request.retries,
        },
    )

    try:
        result = send_invite_email(to_email, token, role=role, expires_at=expires_at)

        logger.info(
            "email_tasks.invite_sent",
            extra={
                "to": to_email,
                "invite_id": invite_id or "unknown",
                "message_id": result.get("message_id"),
                "provider": result.get("provider"),
            },
        )

        if invite_id:
            update_invite_delivery_status(
                invite_id,
                status="sent",
                message_id=result.get("message_id"),
                provider=result.get("provider"),
            )

        return {"status": "sent", "to": to_email, **result}

    except MaxRetriesExceededError:
        # Final failure after all retries — persist "failed" status.
        logger.error(
            "email_tasks.invite_send_exhausted",
            extra={"to": to_email, "invite_id": invite_id or "unknown"},
        )
        if invite_id:
            update_invite_delivery_status(
                invite_id,
                status="failed",
                error="Max retries exceeded",
            )
        raise

    except Exception as exc:
        logger.warning(
            "email_tasks.invite_send_retry",
            extra={
                "to": to_email,
                "invite_id": invite_id or "unknown",
                "error": str(exc)[:300],
                "retries": self.request.retries,
            },
        )
        # Record error for this attempt but do not mark "failed" yet — still retrying.
        if invite_id:
            update_invite_delivery_status(
                invite_id,
                status="pending",   # still in-flight
                error=str(exc),
            )
        try:
            raise self.retry(exc=exc) from exc
        except MaxRetriesExceededError:
            if invite_id:
                update_invite_delivery_status(
                    invite_id,
                    status="failed",
                    error=f"Max retries exceeded. Last error: {exc!s}",
                )
            raise


@celery_app.task(
    name="app.tasks.email_tasks.send_generic_email",
    bind=True,
    max_retries=3,
    retry_backoff=True,
    retry_backoff_max=120,
    retry_jitter=True,
    queue=QUEUE_EMAIL,
    time_limit=60,
)
def send_generic_email_task(
    self: Task,
    to_email: str,
    subject: str,
    body_text: str,
) -> dict[str, Any]:
    """Send a plain-text transactional email asynchronously."""
    try:
        import smtplib
        from email.message import EmailMessage

        from app.core.config import get_settings

        settings = get_settings()
        if not settings.smtp_user or not settings.smtp_password or not settings.smtp_from:
            raise RuntimeError("SMTP credentials not configured.")

        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = settings.smtp_from
        msg["To"] = to_email
        msg.set_content(body_text)

        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as server:
            server.starttls()
            server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(msg)

        logger.info("email_tasks.generic_sent", extra={"to": to_email, "subject": subject[:80]})
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        logger.warning(
            "email_tasks.generic_send_failed",
            extra={"to": to_email, "error": str(exc)[:300], "retries": self.request.retries},
        )
        raise self.retry(exc=exc) from exc
