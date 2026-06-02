"""F-INV-04: Brevo SMTP email service for transactional messages.

send_invite_email          — builds + sends the invite HTML/plain-text email.
send_invite_email_background — convenience wrapper used as the dispatch_task
                               fallback; accepts the full kwargs dict from the
                               route and updates invite delivery tracking.
update_invite_delivery_status — DB helper; called from background workers to
                               persist delivery outcome on the invite record.
"""
from __future__ import annotations

import logging
import smtplib
import uuid
from datetime import UTC, datetime
from email.message import EmailMessage
from textwrap import dedent
from urllib.parse import quote

from app.core.config import get_settings

logger = logging.getLogger(__name__)

SUBJECT_INVITE = "You're invited to AIRIS"
DELIVERY_PROVIDER = "brevo_smtp"


# ── Link builder ─────────────────────────────────────────────────────────────


def _invite_link(token: str) -> str:
    settings = get_settings()
    base = settings.frontend_url.rstrip("/")
    return f"{base}/invite/accept?token={quote(token, safe='')}"


# ── Email body builders ───────────────────────────────────────────────────────


def _expiry_text(expires_at: datetime | None) -> str:
    if expires_at is None:
        return "expires in 7 days"
    now = datetime.now(UTC)
    delta = expires_at - now
    days = delta.days
    if days < 0:
        return "has already expired"
    if days == 0:
        return "expires today"
    if days == 1:
        return "expires tomorrow"
    # Pretty date for longer windows — %-d is Unix-only, strip leading zero manually
    date_str = expires_at.strftime("%B %d, %Y").replace(" 0", " ") if hasattr(expires_at, "strftime") else str(expires_at)
    return f"expires on {date_str}"


def _role_display(role: str | None) -> str:
    if not role:
        return "team member"
    # Convert slug → readable: "client_viewer" → "Client Viewer"
    return role.replace("_", " ").title()


def _html_body(link: str, role: str | None, expires_at: datetime | None) -> str:
    role_display = _role_display(role)
    expiry = _expiry_text(expires_at)
    return dedent(f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>You're invited to AIRIS</title>
    </head>
    <body style="margin:0;padding:0;background-color:#F1F5F9;font-family:Arial,Helvetica,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
             style="background-color:#F1F5F9;padding:40px 16px;">
        <tr><td align="center">
          <table width="580" cellpadding="0" cellspacing="0" role="presentation"
                 style="max-width:580px;width:100%;background:#ffffff;border-radius:10px;
                        overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">

            <!-- ── Header ── -->
            <tr>
              <td style="background:#0F172A;padding:24px 36px;">
                <span style="color:#FF5A1F;font-size:22px;font-weight:700;letter-spacing:-0.5px;">
                  AIRIS
                </span>
                <span style="color:#94A3B8;font-size:12px;margin-left:10px;
                             vertical-align:middle;letter-spacing:0.5px;text-transform:uppercase;">
                  AI Recruitment Platform
                </span>
              </td>
            </tr>

            <!-- ── Body ── -->
            <tr>
              <td style="padding:40px 36px 28px;">
                <h1 style="margin:0 0 16px;color:#0F172A;font-size:26px;font-weight:700;
                           line-height:1.25;">
                  You&#8217;re invited!
                </h1>
                <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.65;">
                  You have been invited to join the AIRIS platform as a
                  <strong style="color:#0F172A;">{role_display}</strong>.
                </p>
                <p style="margin:0 0 32px;color:#374151;font-size:15px;line-height:1.65;">
                  Click the button below to accept your invitation and set up your account.
                </p>

                <!-- CTA button -->
                <table cellpadding="0" cellspacing="0" role="presentation">
                  <tr>
                    <td style="border-radius:6px;background:#FF5A1F;">
                      <a href="{link}"
                         style="display:inline-block;padding:14px 36px;color:#ffffff;
                                font-size:15px;font-weight:600;text-decoration:none;
                                border-radius:6px;letter-spacing:0.2px;">
                        Accept Invitation
                      </a>
                    </td>
                  </tr>
                </table>

                <!-- Fallback URL -->
                <p style="margin:28px 0 0;color:#9CA3AF;font-size:12px;line-height:1.6;">
                  Or paste this link into your browser:<br>
                  <a href="{link}" style="color:#4B5563;word-break:break-all;">{link}</a>
                </p>
              </td>
            </tr>

            <!-- ── Expiry notice ── -->
            <tr>
              <td style="background:#FFF7ED;padding:14px 36px;
                         border-top:1px solid #FED7AA;">
                <p style="margin:0;color:#92400E;font-size:13px;line-height:1.5;">
                  &#9888; This invitation <strong>{expiry}</strong>.
                  If you did not expect this email you can safely ignore it.
                </p>
              </td>
            </tr>

            <!-- ── Footer ── -->
            <tr>
              <td style="background:#F8FAFC;padding:16px 36px;
                         border-top:1px solid #E5E7EB;">
                <p style="margin:0;color:#9CA3AF;font-size:11px;line-height:1.6;">
                  AIRIS &mdash; AI Recruitment Intelligence System &nbsp;|&nbsp;
                  This is an automated message, please do not reply.
                </p>
              </td>
            </tr>

          </table>
        </td></tr>
      </table>
    </body>
    </html>
    """).strip()


def _plain_body(link: str, role: str | None, expires_at: datetime | None) -> str:
    role_display = _role_display(role)
    expiry = _expiry_text(expires_at)
    return (
        f"You have been invited to join AIRIS as a {role_display}.\n\n"
        f"Accept your invitation here:\n{link}\n\n"
        f"Note: This invitation {expiry}.\n\n"
        "If you did not expect this email you can safely ignore it.\n\n"
        "— AIRIS AI Recruitment Intelligence System"
    )


# ── Core send function ────────────────────────────────────────────────────────


def send_invite_email(
    to_email: str,
    token: str,
    *,
    role: str | None = None,
    expires_at: datetime | None = None,
) -> dict[str, str]:
    """Build and send an invite email via Brevo SMTP (STARTTLS).

    Returns a dict with keys ``message_id`` and ``provider`` on success.
    Raises on failure so the caller (Celery task or fallback thread) can
    handle retries and update delivery_status.
    """
    settings = get_settings()
    if not settings.smtp_user or not settings.smtp_password:
        msg = "SMTP_USER or SMTP_PASSWORD not set — cannot send invite email."
        logger.error(
            "email_service.smtp_credentials_missing",
            extra={"to": to_email},
        )
        raise RuntimeError(msg)
    if not settings.smtp_from:
        msg = "SMTP_FROM not set — cannot send invite email."
        logger.error("email_service.smtp_from_missing", extra={"to": to_email})
        raise RuntimeError(msg)

    link = _invite_link(token)
    # Self-generated RFC 5321 Message-ID — Brevo SMTP relay does not expose one.
    message_id = f"<{uuid.uuid4().hex}@airis.invite>"

    msg = EmailMessage()
    msg["Subject"] = SUBJECT_INVITE
    msg["From"] = settings.smtp_from
    msg["To"] = to_email
    msg["Message-ID"] = message_id
    msg.set_content(_plain_body(link, role, expires_at))
    msg.add_alternative(_html_body(link, role, expires_at), subtype="html")

    logger.info(
        "email_service.invite_send_attempt",
        extra={
            "to": to_email,
            "role": role or "unknown",
            "message_id": message_id,
            "smtp_host": settings.smtp_host,
            "smtp_port": settings.smtp_port,
        },
    )

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as server:
            server.starttls()
            server.login(settings.smtp_user, settings.smtp_password)
            refused = server.send_message(msg)

        if refused:
            # smtplib returns refused recipients; treat as delivery failure.
            raise RuntimeError(f"SMTP refused recipients: {refused}")

        logger.info(
            "email_service.invite_sent",
            extra={"to": to_email, "message_id": message_id, "provider": DELIVERY_PROVIDER},
        )
        return {"message_id": message_id, "provider": DELIVERY_PROVIDER}

    except Exception:
        logger.exception(
            "email_service.invite_send_failed",
            extra={"to": to_email, "message_id": message_id},
        )
        raise


# ── Delivery status DB helper ─────────────────────────────────────────────────


def update_invite_delivery_status(
    invite_id: str,
    *,
    status: str,  # "sent" | "failed"
    message_id: str | None = None,
    provider: str | None = None,
    error: str | None = None,
) -> None:
    """Persist delivery outcome on the invite record.

    Creates its own DB session — safe to call from background threads
    (ThreadPoolExecutor fallback or Celery worker).
    """
    from datetime import UTC, datetime

    import sqlalchemy as sa

    from app.db.session import SessionLocal
    from app.models.invite import Invite

    now = datetime.now(UTC)
    db = SessionLocal()
    try:
        values: dict = {
            "delivery_status": status,
            "delivery_attempts": Invite.delivery_attempts + 1,
            "last_delivery_attempt_at": now,
        }
        if message_id:
            values["message_id"] = message_id
        if provider:
            values["delivery_provider"] = provider
        if error is not None:
            # Truncate to fit column; null out on success
            values["last_delivery_error"] = error[:500] if error else None
        elif status == "sent":
            values["last_delivery_error"] = None  # clear any previous error on success

        from uuid import UUID as _UUID
        db.execute(
            sa.update(Invite)
            .where(Invite.id == _UUID(invite_id))
            .values(**values)
        )
        db.commit()
        logger.info(
            "email_service.delivery_status_updated",
            extra={"invite_id": invite_id, "status": status},
        )
    except Exception:
        logger.exception(
            "email_service.delivery_status_update_failed",
            extra={"invite_id": invite_id, "status": status},
        )
    finally:
        db.close()


# ── Background fallback function ──────────────────────────────────────────────


def send_invite_email_background(
    to_email: str,
    token: str,
    *,
    role: str | None = None,
    expires_at_iso: str | None = None,
    invite_id: str | None = None,
) -> None:
    """Fallback used by dispatch_task when Celery is unavailable.

    Accepts the same kwargs as send_invite_email_task so dispatch_task can
    call either interchangeably.  Updates invite delivery tracking in DB.
    """
    expires_at: datetime | None = None
    if expires_at_iso:
        try:
            expires_at = datetime.fromisoformat(expires_at_iso)
        except ValueError:
            logger.warning(
                "email_service.invalid_expires_at_iso",
                extra={"invite_id": invite_id, "value": expires_at_iso[:64]},
            )

    try:
        result = send_invite_email(to_email, token, role=role, expires_at=expires_at)
        if invite_id:
            update_invite_delivery_status(
                invite_id,
                status="sent",
                message_id=result["message_id"],
                provider=result["provider"],
            )
    except Exception as exc:
        if invite_id:
            update_invite_delivery_status(
                invite_id,
                status="failed",
                error=str(exc),
            )
        raise
