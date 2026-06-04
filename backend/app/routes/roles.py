from __future__ import annotations

import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user, get_user_permissions, require_admin
from app.core.permissions import ALL_PERMISSIONS, USERS_INVITE
from app.db.session import get_db
from app.models.organization_role import OrganizationRole
from app.models.profile import Profile
from app.models.role_permission import RolePermission
from app.schemas.auth import CurrentUser
from app.services.organization_role_service import make_unique_role_key, slugify_role_name
from app.services.permission_service import invalidate_permission_cache

router = APIRouter()
logger = logging.getLogger(__name__)
class OrganizationRoleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    name: str
    key: str
    user_count: int = 0


class CreateOrganizationRoleRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)


class RolePermissionsPayload(BaseModel):
    permissions: list[str]


def _normalize_requested_permissions(values: list[str]) -> list[str]:
    allowed = set(ALL_PERMISSIONS)
    normalized = sorted({value.strip().lower() for value in values if value and value.strip()})
    invalid = [permission for permission in normalized if permission not in allowed]
    if invalid:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid permissions: {', '.join(invalid)}",
        )
    return normalized


def _require_admin_or_invite(
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> CurrentUser:
    """List roles for user-assignment UI (admins + users with users:invite)."""
    role_key = (current_user.role or "").strip().lower()
    if role_key == "admin":
        return current_user
    if role_key == "vendor":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden.")
    permissions = get_user_permissions(db, current_user.organization_id, current_user.role, user_id=current_user.user_id)
    if USERS_INVITE in permissions:
        return current_user
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden.")


@router.get("/legacy-permissions-map", response_model=dict[str, list[str]])
def get_legacy_role_permissions_map(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_admin)],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> dict[str, list[str]]:
    """
    Legacy map shape preserved for backward compatibility with older admin clients.
    """
    org_id = UUID(current_user.organization_id)
    stmt = (
        select(OrganizationRole.key, RolePermission.permission)
        .join(OrganizationRole, RolePermission.role_id == OrganizationRole.id)
        .where(RolePermission.organization_id == org_id)
    )
    rows = db.execute(stmt).all()
    grouped: dict[str, list[str]] = {}
    for role_key, permission in rows:
        key = (role_key or "").strip().lower()
        if key == "client":
            key = "client_viewer"
        grouped.setdefault(key, [])
        perm = (permission or "").strip().lower()
        if perm and perm not in grouped[key]:
            grouped[key].append(perm)
    for key in grouped:
        grouped[key].sort()
    return grouped


def _get_org_role_for_org(
    db: Session,
    *,
    organization_id: UUID,
    role_id: UUID,
) -> OrganizationRole:
    role = db.scalar(
        select(OrganizationRole).where(
            OrganizationRole.id == role_id,
            OrganizationRole.organization_id == organization_id,
        )
    )
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Role not found.")
    return role


@router.get("", response_model=list[OrganizationRoleOut])
def list_organization_roles(
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[CurrentUser, Depends(_require_admin_or_invite)],
):
    from sqlalchemy import func
    org_id = UUID(current_user.organization_id)
    stmt = (
        select(OrganizationRole, func.count(Profile.id).label("user_count"))
        .outerjoin(Profile, Profile.role_id == OrganizationRole.id)
        .where(OrganizationRole.organization_id == org_id)
        .group_by(OrganizationRole.id)
        .order_by(OrganizationRole.name.asc())
    )
    rows = db.execute(stmt).all()
    return [
        {
            "id": role.id,
            "organization_id": role.organization_id,
            "name": role.name,
            "key": role.key,
            "user_count": count,
        }
        for role, count in rows
    ]


@router.post("", response_model=OrganizationRoleOut, status_code=status.HTTP_201_CREATED)
def create_organization_role(
    payload: CreateOrganizationRoleRequest,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_admin)],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> OrganizationRole:
    org_id = UUID(current_user.organization_id)
    base_key = slugify_role_name(payload.name)
    key = make_unique_role_key(db, org_id, base_key)
    row = OrganizationRole(
        organization_id=org_id,
        name=payload.name.strip(),
        key=key,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    invalidate_permission_cache()
    return row


@router.get("/{role_id}/permissions", response_model=list[str])
def get_role_permission_codes(
    role_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_admin)],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> list[str]:
    org_id = UUID(current_user.organization_id)
    _get_org_role_for_org(db, organization_id=org_id, role_id=role_id)
    stmt = select(RolePermission.permission).where(
        RolePermission.organization_id == org_id,
        RolePermission.role_id == role_id,
    )
    codes = sorted({p for p in db.scalars(stmt).all()})
    return codes


@router.post("/{role_id}/permissions", response_model=list[str])
def replace_role_permissions(
    role_id: UUID,
    payload: RolePermissionsPayload,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_admin)],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> list[str]:
    """
    Replace all permissions assigned to this role (tenant-isolated).
    """
    org_id = UUID(current_user.organization_id)
    _get_org_role_for_org(db, organization_id=org_id, role_id=role_id)
    permissions = _normalize_requested_permissions(payload.permissions)

    db.execute(
        delete(RolePermission).where(
            RolePermission.organization_id == org_id,
            RolePermission.role_id == role_id,
        )
    )
    for code in permissions:
        db.add(
            RolePermission(
                organization_id=org_id,
                role_id=role_id,
                permission=code,
            )
        )
    db.commit()
    invalidate_permission_cache()
    return permissions


@router.delete("/{role_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def delete_organization_role(
    role_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_admin)],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> Response:
    """
    Delete an organization role (admin only).

    Blocked with **409 CONFLICT** when one or more users are still assigned this role.
    The response body includes ``code: "ROLE_IN_USE"`` and a list of ``affected_users``
    (id + email) so the caller can surface a meaningful error message.

    On success the role and all its role_permissions rows are hard-deleted (204).
    Deletion is recorded as a structured audit log entry.
    """
    org_id = UUID(current_user.organization_id)
    role = _get_org_role_for_org(db, organization_id=org_id, role_id=role_id)

    # ── Safety check: block deletion if any user is currently assigned this role ──
    assigned_profiles = list(
        db.scalars(
            select(Profile).where(
                Profile.organization_id == org_id,
                Profile.role_id == role_id,
            )
        ).all()
    )

    if assigned_profiles:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Role is assigned to active users and cannot be deleted.",
                "code": "ROLE_IN_USE",
                "affected_users": [
                    {"id": str(p.id), "email": p.email}
                    for p in assigned_profiles
                ],
            },
        )

    # Capture for audit log before deletion
    role_name = role.name
    role_key = role.key

    # Cascade: delete all role_permissions tied to this role before removing the role
    db.execute(
        delete(RolePermission).where(
            RolePermission.organization_id == org_id,
            RolePermission.role_id == role_id,
        )
    )
    db.delete(role)
    db.commit()

    # ── Audit trail (structured log) ─────────────────────────────────────────────
    logger.info(
        "role.deleted",
        extra={
            "role_id": str(role_id),
            "role_key": role_key,
            "role_name": role_name,
            "organization_id": str(org_id),
            "deleted_by_user_id": current_user.user_id,
        },
    )

    invalidate_permission_cache()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
