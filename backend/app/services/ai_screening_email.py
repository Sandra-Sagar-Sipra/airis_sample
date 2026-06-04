"""Email template and sender for AI Screening interview invitations.

Sends the candidate a branded email with a direct link to their self-service
AI screening interview. No login required — the secure token in the URL is
the credential.
"""
from __future__ import annotations

import logging
import smtplib
import uuid
from datetime import UTC, datetime
from email.message import EmailMessage
from textwrap import dedent

from app.core.config import get_settings

logger = logging.getLogger(__name__)


def _interview_url(token: str) -> str:
    settings = get_settings()
    base = settings.frontend_url.rstrip("/")
    return f"{base}/interview/{token}"


def _format_expiry(expires_at: datetime | None) -> str:
    if expires_at is None:
        return "7 days from now"
    now = datetime.now(UTC)
    delta = expires_at - now
    days = delta.days
    if days < 0:
        return "already expired"
    if days == 0:
        return "today"
    if days == 1:
        return "tomorrow"
    return expires_at.strftime("%B %d, %Y at %I:%M %p UTC")


def _html_body(
    candidate_name: str,
    job_title: str,
    interview_url: str,
    duration_minutes: int,
    expires_at: datetime | None,
) -> str:
    expiry_text = _format_expiry(expires_at)
    first_name = candidate_name.split()[0] if candidate_name else "there"
    return dedent(f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Complete Your AI Screening Interview</title>
    </head>
    <body style="margin:0;padding:0;background-color:#F1F5F9;font-family:Arial,Helvetica,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
             style="background-color:#F1F5F9;padding:40px 16px;">
        <tr><td align="center">
          <table width="580" cellpadding="0" cellspacing="0" role="presentation"
                 style="max-width:580px;width:100%;background:#ffffff;border-radius:10px;
                        overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">

            <!-- Header -->
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

            <!-- Body -->
            <tr>
              <td style="padding:40px 36px 28px;">
                <h1 style="margin:0 0 8px;color:#0F172A;font-size:24px;font-weight:700;">
                  Hi {first_name}, you&rsquo;re invited!
                </h1>
                <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.65;">
                  You have been invited to complete an <strong>AI Screening Interview</strong>
                  for the <strong style="color:#0F172A;">{job_title}</strong> position.
                </p>

                <!-- Details box -->
                <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                       style="background:#F8FAFC;border:1px solid #E5E7EB;border-radius:8px;
                              margin-bottom:28px;">
                  <tr>
                    <td style="padding:20px 24px;">
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="padding:4px 0;color:#6B7280;font-size:13px;width:40%;">
                            &#127775; Role
                          </td>
                          <td style="padding:4px 0;color:#111827;font-size:13px;font-weight:600;">
                            {job_title}
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;color:#6B7280;font-size:13px;">
                            &#9201; Duration
                          </td>
                          <td style="padding:4px 0;color:#111827;font-size:13px;font-weight:600;">
                            Approximately {duration_minutes} minutes
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;color:#6B7280;font-size:13px;">
                            &#128197; Expires
                          </td>
                          <td style="padding:4px 0;color:#111827;font-size:13px;font-weight:600;">
                            {expiry_text}
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.65;">
                  The interview is conducted by an AI interviewer via video. You will be asked
                  recruiter-style questions about your background, experience, and career goals.
                  No technical coding questions.
                </p>

                <!-- CTA button -->
                <table cellpadding="0" cellspacing="0" role="presentation">
                  <tr>
                    <td style="border-radius:8px;background:#FF5A1F;">
                      <a href="{interview_url}"
                         style="display:inline-block;padding:14px 40px;color:#ffffff;
                                font-size:16px;font-weight:600;text-decoration:none;
                                border-radius:8px;letter-spacing:0.2px;">
                        Start Interview
                      </a>
                    </td>
                  </tr>
                </table>

                <!-- Tips -->
                <p style="margin:28px 0 8px;color:#374151;font-size:13px;font-weight:600;">
                  Before you begin:
                </p>
                <ul style="margin:0;padding-left:20px;color:#6B7280;font-size:13px;line-height:1.8;">
                  <li>Ensure your camera and microphone are working</li>
                  <li>Find a quiet, well-lit location</li>
                  <li>The AI will speak each question aloud</li>
                  <li>Speak naturally &mdash; take your time to answer fully</li>
                </ul>

                <!-- Fallback URL -->
                <p style="margin:24px 0 0;color:#9CA3AF;font-size:12px;line-height:1.6;">
                  If the button above doesn&rsquo;t work, paste this link into your browser:<br>
                  <a href="{interview_url}" style="color:#4B5563;word-break:break-all;">{interview_url}</a>
                </p>
              </td>
            </tr>

            <!-- Expiry notice -->
            <tr>
              <td style="background:#FFF7ED;padding:14px 36px;border-top:1px solid #FED7AA;">
                <p style="margin:0;color:#92400E;font-size:13px;line-height:1.5;">
                  &#9888; This interview link expires <strong>{expiry_text}</strong>.
                  If you did not apply for this position you can safely ignore this email.
                </p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background:#F8FAFC;padding:16px 36px;border-top:1px solid #E5E7EB;">
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


def _plain_body(
    candidate_name: str,
    job_title: str,
    interview_url: str,
    duration_minutes: int,
    expires_at: datetime | None,
) -> str:
    expiry_text = _format_expiry(expires_at)
    first_name = candidate_name.split()[0] if candidate_name else "there"
    return (
        f"Hi {first_name},\n\n"
        f"You have been invited to complete an AI Screening Interview for the "
        f"{job_title} position.\n\n"
        f"Details:\n"
        f"  Role: {job_title}\n"
        f"  Duration: Approximately {duration_minutes} minutes\n"
        f"  Expires: {expiry_text}\n\n"
        f"Start your interview here:\n{interview_url}\n\n"
        f"The interview is conducted by an AI via video. You will be asked recruiter-style "
        f"questions about your background and experience. No technical coding questions.\n\n"
        f"Before you begin:\n"
        f"  - Ensure your camera and microphone are working\n"
        f"  - Find a quiet, well-lit location\n"
        f"  - Speak naturally and take your time\n\n"
        f"This link expires {expiry_text}.\n\n"
        "— AIRIS AI Recruitment Intelligence System"
    )


def send_ai_screening_invite(
    to_email: str,
    candidate_name: str,
    job_title: str,
    token: str,
    *,
    duration_minutes: int = 20,
    expires_at: datetime | None = None,
) -> dict[str, str]:
    """Send AI Screening interview invite email via Brevo SMTP.

    Returns dict with message_id and provider on success. Raises on failure.
    """
    settings = get_settings()
    if not settings.smtp_user or not settings.smtp_password:
        raise RuntimeError("SMTP_USER or SMTP_PASSWORD not configured")
    if not settings.smtp_from:
        raise RuntimeError("SMTP_FROM not configured")

    interview_url = _interview_url(token)
    message_id = f"<{uuid.uuid4().hex}@airis.screening>"

    msg = EmailMessage()
    msg["Subject"] = f"Complete Your AI Screening Interview — {job_title}"
    msg["From"] = settings.smtp_from
    msg["To"] = to_email
    msg["Message-ID"] = message_id
    msg.set_content(_plain_body(candidate_name, job_title, interview_url, duration_minutes, expires_at))
    msg.add_alternative(
        _html_body(candidate_name, job_title, interview_url, duration_minutes, expires_at),
        subtype="html",
    )

    logger.info(
        "ai_screening_email.send_attempt to=%s job=%s",
        to_email, job_title,
    )

    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as server:
        server.starttls()
        server.login(settings.smtp_user, settings.smtp_password)
        refused = server.send_message(msg)

    if refused:
        raise RuntimeError(f"SMTP refused recipients: {refused}")

    logger.info("ai_screening_email.sent to=%s message_id=%s", to_email, message_id)
    return {"message_id": message_id, "provider": "brevo_smtp"}
