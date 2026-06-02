from __future__ import annotations

import logging
import smtplib
from datetime import UTC, datetime, timedelta
import secrets
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user, get_user_permissions
from app.core.permissions import USERS_INVITE
from app.core.security import hash_password
from app.db.session import get_db
from app.models.invite import (
    INVITE_STATUS_ACCEPTED,
    INVITE_STATUS_EXPIRED,
    INVITE_STATUS_OPENED,
    INVITE_STATUS_SENT,
    Invite,
)
from app.models.profile import Profile
from app.schemas.auth import CurrentUser, UserType
from app.schemas.invite import (
    InviteAcceptRequest,
    InviteAcceptResponse,
    InviteCreate,
    InviteCreateResponse,
    InviteListItem,
    InviteResendResponse,
    InviteResponse,
    SmtpCheckResponse,
)
from app.services.email_service import send_invite_email_background
from app.services.organization_role_service import get_role_id_by_key
from app.services.task_runner import dispatch_task
from app.tasks.email_tasks import send_invite_email_task

logger = logging.getLogger(__name__)

router = APIRouter()

# Statuses that count as "active" (not yet terminal)
_ACTIVE_STATUSES = {INVITE_STATUS_SENT, INVITE_STATUS_OPENED}


def _generate_invite_token() -> str:
    return secrets.token_urlsafe(32)


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _require_invite_access(
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> CurrentUser:
    role_key = (current_user.role or "").strip().lower()
    if role_key == "admin":
        return current_user
    if role_key == "vendor":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: vendor cannot manage users/roles.",
        )

    permissions = get_user_permissions(
        db, current_user.organization_id, current_user.role, user_id=current_user.user_id
    )
    if USERS_INVITE in permissions:
        return current_user

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Forbidden: insufficient permissions.",
    )


# ── Serialisation helpers ──────────────────────────────────────────────────────


def _invite_to_list_item(invite: Invite) -> InviteListItem:
    return InviteListItem(
        id=str(invite.id),
        email=invite.email,
        role=invite.role,
        status=invite.status,
        created_at=invite.created_at,
        expires_at=invite.expires_at,
        sent_at=invite.sent_at,
        opened_at=invite.opened_at,
        accepted_at=invite.accepted_at,
        expired_at=invite.expired_at,
        # F-INV-04
        delivery_status=getattr(invite, "delivery_status", "pending") or "pending",
        delivery_attempts=getattr(invite, "delivery_attempts", 0) or 0,
        last_delivery_attempt_at=getattr(invite, "last_delivery_attempt_at", None),
    )


def _invite_to_response(invite: Invite) -> InviteResponse:
    return InviteResponse(
        id=str(invite.id),
        email=invite.email,
        organization_id=str(invite.organization_id),
        role=invite.role,
        status=invite.status,
        expires_at=invite.expires_at,
        created_at=invite.created_at,
        sent_at=invite.sent_at,
        opened_at=invite.opened_at,
        accepted_at=invite.accepted_at,
        expired_at=invite.expired_at,
        # F-INV-04
        delivery_status=getattr(invite, "delivery_status", "pending") or "pending",
        delivery_provider=getattr(invite, "delivery_provider", None),
        message_id=getattr(invite, "message_id", None),
        delivery_attempts=getattr(invite, "delivery_attempts", 0) or 0,
        last_delivery_attempt_at=getattr(invite, "last_delivery_attempt_at", None),
        last_delivery_error=getattr(invite, "last_delivery_error", None),
    )


# ── Routes ─────────────────────────────────────────────────────────────────────


@router.get("", response_model=list[InviteListItem])
def list_invites(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(_require_invite_access)],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> list[InviteListItem]:
    organization_id = UUID(current_user.organization_id)
    invites = db.scalars(
        select(Invite)
        .where(Invite.organization_id == organization_id)
        .order_by(Invite.created_at.desc())
    ).all()
    return [_invite_to_list_item(inv) for inv in invites]


@router.post("", response_model=InviteCreateResponse, status_code=status.HTTP_201_CREATED)
def create_invite(
    payload: InviteCreate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(_require_invite_access)],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> InviteCreateResponse:
    normalized_email = str(payload.email).lower().strip()
    organization_id = UUID(current_user.organization_id)

    # ── Guard: user already exists ─────────────────────────────────────────────
    existing_profile = db.scalar(
        select(Profile.id).where(func.lower(Profile.email) == normalized_email)
    )
    if existing_profile is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User with this email already exists.",
        )

    # ── Guard: active duplicate invite ────────────────────────────────────────
    active_invite = db.scalar(
        select(Invite.id).where(
            Invite.organization_id == organization_id,
            func.lower(Invite.email) == normalized_email,
            Invite.status.in_(_ACTIVE_STATUSES),
        )
    )
    if active_invite is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An active invite already exists for this email.",
        )

    # ── Guard: role must exist for this org ───────────────────────────────────
    role_key = payload.role.strip().lower()
    if get_role_id_by_key(db, organization_id, role_key) is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid role for this organization.",
        )

    # ── Create invite ─────────────────────────────────────────────────────────
    now = _now_utc()
    expires_at = now + timedelta(days=payload.expires_in_days)
    invite = Invite(
        email=normalized_email,
        organization_id=organization_id,
        role=role_key,
        token=_generate_invite_token(),
        status=INVITE_STATUS_SENT,   # F-INV-05: lifecycle starts at 'sent'
        expires_at=expires_at,
        sent_at=now,                 # F-INV-05: record send timestamp
        # F-INV-04: initial delivery state
        delivery_status="pending",
        delivery_attempts=0,
    )
    db.add(invite)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Unable to create invite due to a unique constraint conflict.",
        ) from None
    db.refresh(invite)

    # ── Dispatch email off HTTP thread ────────────────────────────────────────
    # apply_async blocks for 60 s when Redis is unreachable, killing the DB
    # connection.  dispatch_task submits to a ThreadPoolExecutor and returns
    # immediately.  Delivery status is written back to DB by the worker.
    logger.info(
        "invites.create.email_dispatch",
        extra={"invite_id": str(invite.id), "email": normalized_email, "role": role_key},
    )
    dispatch_task(
        task=send_invite_email_task,
        fallback=send_invite_email_background,
        kwargs={
            "to_email": normalized_email,
            "token": invite.token,
            "role": role_key,
            "expires_at_iso": invite.expires_at.isoformat(),
            "invite_id": str(invite.id),
        },
    )

    return InviteCreateResponse(
        message="Invite created successfully.",
        invite=_invite_to_response(invite),
        token=invite.token,
    )


@router.get("/open", status_code=status.HTTP_204_NO_CONTENT)
def open_invite(
    token: Annotated[str, Query(min_length=8, max_length=255)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    """F-INV-05: Mark an invite as 'opened' when the recipient visits the accept page.

    Called by the frontend accept page on load. Idempotent — re-visiting the
    page does not overwrite opened_at once already set. Returns 204 whether
    or not the invite exists (prevents token enumeration).
    """
    invite = db.scalar(select(Invite).where(Invite.token == token))
    if invite is None or invite.status not in _ACTIVE_STATUSES:
        return  # Idempotent — don't reveal whether token exists

    if invite.expires_at < _now_utc():
        invite.status = INVITE_STATUS_EXPIRED
        invite.expired_at = _now_utc()
        db.add(invite)
        db.commit()
        return

    if invite.status == INVITE_STATUS_SENT:
        invite.status = INVITE_STATUS_OPENED
        invite.opened_at = _now_utc()
        db.add(invite)
        db.commit()
    # If already 'opened', no-op (idempotent)


@router.post("/{invite_id}/resend", response_model=InviteResendResponse)
def resend_invite(
    invite_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(_require_invite_access)],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> InviteResendResponse:
    try:
        organization_id = UUID(current_user.organization_id)

        logger.info(
            "invites.resend.lookup",
            extra={"invite_id": str(invite_id), "org_id": str(organization_id)},
        )
        invite = db.scalar(
            select(Invite).where(
                Invite.id == invite_id,
                Invite.organization_id == organization_id,
            )
        )
        if invite is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found."
            )
        if invite.status == INVITE_STATUS_ACCEPTED:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Invite has already been accepted.",
            )

        now = _now_utc()
        # Regenerate token and extend expiry when already expired
        if invite.expires_at < now or invite.status == INVITE_STATUS_EXPIRED:
            invite.token = _generate_invite_token()
            invite.expires_at = now + timedelta(days=7)

        # Reset lifecycle to 'sent'; reset delivery tracking for new attempt window
        invite.status = INVITE_STATUS_SENT
        invite.sent_at = now
        invite.opened_at = None   # clear previous open — resend resets the window
        invite.delivery_status = "pending"

        db.add(invite)
        logger.info(
            "invites.resend.commit",
            extra={"invite_id": str(invite_id), "email": invite.email},
        )
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Unable to resend invite due to token conflict.",
            ) from None
        db.refresh(invite)

        logger.info(
            "invites.resend.email_dispatch",
            extra={"invite_id": str(invite_id), "email": invite.email},
        )
        dispatch_task(
            task=send_invite_email_task,
            fallback=send_invite_email_background,
            kwargs={
                "to_email": invite.email,
                "token": invite.token,
                "role": invite.role,
                "expires_at_iso": invite.expires_at.isoformat(),
                "invite_id": str(invite.id),
            },
        )

        return InviteResendResponse(message="Invite resent successfully.")

    except HTTPException:
        raise
    except Exception:
        logger.exception("invites.resend.failed", extra={"invite_id": str(invite_id)})
        raise


@router.post("/accept", response_model=InviteAcceptResponse)
def accept_invite(
    payload: InviteAcceptRequest,
    db: Annotated[Session, Depends(get_db)],
) -> InviteAcceptResponse:
    invite = db.scalar(select(Invite).where(Invite.token == payload.token))
    if invite is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found."
        )
    if invite.status == INVITE_STATUS_ACCEPTED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Invite has already been accepted.",
        )
    if invite.status == INVITE_STATUS_EXPIRED or invite.expires_at < _now_utc():
        raise HTTPException(
            status_code=status.HTTP_410_GONE, detail="Invite has expired."
        )

    existing_profile = db.scalar(
        select(Profile.id).where(func.lower(Profile.email) == invite.email)
    )
    if existing_profile is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User already exists for this invite email.",
        )

    role_key = invite.role.strip().lower()
    role_id = get_role_id_by_key(db, invite.organization_id, role_key)
    if role_id is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Invite references a role that no longer exists for this organization.",
        )

    profile = Profile(
        organization_id=invite.organization_id,
        email=invite.email,
        role=role_key,
        role_id=role_id,
        type=UserType.INTERNAL,
        password_hash=hash_password(payload.password),
    )
    invite.status = INVITE_STATUS_ACCEPTED   # F-INV-05
    invite.accepted_at = _now_utc()          # F-INV-05

    db.add(profile)
    db.add(invite)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Failed to accept invite due to a data conflict.",
        ) from None

    return InviteAcceptResponse(message="Invite accepted successfully.")


# ── F-INV-04: SMTP diagnostic endpoint ────────────────────────────────────────


@router.get(
    "/smtp-check",
    response_model=SmtpCheckResponse,
    summary="Verify Brevo SMTP configuration (admin only)",
)
def smtp_check(
    _: Annotated[CurrentUser, Depends(_require_invite_access)],
    send_to: str | None = Query(
        default=None,
        description="If provided, send a test email to this address.",
    ),
) -> SmtpCheckResponse:
    """Validate SMTP credentials and optionally send a test email.

    Returns a structured response indicating whether the connection,
    authentication, and (optionally) test-send each succeeded.
    """
    from app.core.config import get_settings

    settings = get_settings()
    result = SmtpCheckResponse(
        connected=False,
        authenticated=False,
        test_sent=False,
        smtp_host=settings.smtp_host,
        smtp_port=settings.smtp_port,
        smtp_from=settings.smtp_from,
    )

    if not settings.smtp_user or not settings.smtp_password or not settings.smtp_from:
        result.error = (
            "SMTP credentials incomplete: "
            f"SMTP_USER={'set' if settings.smtp_user else 'MISSING'}, "
            f"SMTP_PASSWORD={'set' if settings.smtp_password else 'MISSING'}, "
            f"SMTP_FROM={settings.smtp_from or 'MISSING'}"
        )
        logger.warning("invites.smtp_check.credentials_incomplete", extra={"error": result.error})
        return result

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as server:
            server.ehlo()
            result.connected = True

            server.starttls()
            server.ehlo()

            server.login(settings.smtp_user, settings.smtp_password)
            result.authenticated = True

            if send_to:
                from email.message import EmailMessage
                msg = EmailMessage()
                msg["Subject"] = "[AIRIS] SMTP configuration test"
                msg["From"] = settings.smtp_from
                msg["To"] = send_to
                msg.set_content(
                    "This is an automated SMTP configuration test from AIRIS.\n"
                    "If you received this email, Brevo SMTP delivery is working correctly."
                )
                refused = server.send_message(msg)
                if refused:
                    result.error = f"SMTP refused recipient: {refused}"
                    logger.warning("invites.smtp_check.send_refused", extra={"refused": str(refused)})
                else:
                    result.test_sent = True
                    logger.info("invites.smtp_check.test_sent", extra={"to": send_to})

    except smtplib.SMTPAuthenticationError as exc:
        result.error = f"Authentication failed: {exc.smtp_error!r}"
        logger.error("invites.smtp_check.auth_failed", extra={"error": result.error})
    except smtplib.SMTPConnectError as exc:
        result.error = f"Connection failed: {exc}"
        logger.error("invites.smtp_check.connect_failed", extra={"error": result.error})
    except Exception as exc:
        result.error = str(exc)
        logger.exception("invites.smtp_check.unexpected_error")

    return result
