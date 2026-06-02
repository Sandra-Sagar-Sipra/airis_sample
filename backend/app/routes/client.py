"""Client workspace routes — WS-002.

RBAC matrix
───────────────────────────────────────────────────────────────────────────────
Admin       clients:read, clients:create, clients:update, clients:delete,
            clients:assign  →  full global visibility (no recruiter filter)

Recruiter   clients:read  →  scoped to assigned clients only
            clients:assign  →  only if explicitly granted (admin-configurable)

Vendor      no client permissions  →  403 on all client routes

Bug-fix (WS-BUG-01): when a non-admin creates a client they are auto-assigned
so the client is immediately visible in their filtered list.
"""
from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user, require_any_permissions, require_permission
from app.core.permissions import (
    CLIENTS_ASSIGN,
    CLIENTS_CREATE,
    CLIENTS_DELETE,
    CLIENTS_READ,
    CLIENTS_UPDATE,
)
from app.db.session import get_db
from app.schemas.auth import CurrentUser
from app.schemas.client import (
    ClientCreate,
    ClientRecruiterResponse,
    ClientResponse,
    ClientUpdate,
    RecruiterUserResponse,
)
from app.services.client_service import ClientService

router = APIRouter(prefix="/clients", tags=["clients"])

# Roles that have unrestricted (global) visibility over all org clients.
_ADMIN_ROLES: frozenset[str] = frozenset({"admin", "superadmin"})


def _is_admin(current_user: CurrentUser) -> bool:
    return (current_user.role or "").strip().lower() in _ADMIN_ROLES


def _recruiter_id_for_user(current_user: CurrentUser) -> UUID | None:
    """Return caller's user_id for non-admins (drives recruiter-scoped filtering).

    Admin / superadmin → None  (service returns all org clients)
    Recruiter / other  → UUID  (service returns only assigned clients)
    """
    if _is_admin(current_user):
        return None
    return UUID(current_user.user_id)


# ── CRUD ──────────────────────────────────────────────────────────────────────


@router.post("", response_model=ClientResponse, status_code=status.HTTP_201_CREATED)
def create_client(
    payload: ClientCreate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CLIENTS_CREATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> ClientResponse:
    """Create a new client workspace.

    WS-BUG-01 fix: non-admin creators are automatically added to
    ``assigned_recruiter_ids`` so the client is immediately visible in their
    own filtered list (prevents the "client disappears after creation" bug).
    """
    creator_id = UUID(current_user.user_id)

    # Auto-assign creator when they are a non-admin recruiter.
    if not _is_admin(current_user) and creator_id not in payload.assigned_recruiter_ids:
        payload = payload.model_copy(
            update={"assigned_recruiter_ids": list(payload.assigned_recruiter_ids) + [creator_id]}
        )

    service = ClientService(db)
    client = service.create_client(
        organization_id=UUID(current_user.organization_id),
        payload=payload,
        created_by=creator_id,
    )
    return ClientResponse.model_validate(client)


@router.get("", response_model=list[ClientResponse])
def list_clients(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CLIENTS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[ClientResponse]:
    """List clients.  Admin sees all; recruiters see only assigned clients."""
    service = ClientService(db)
    clients = service.list_clients(
        organization_id=UUID(current_user.organization_id),
        limit=limit,
        offset=offset,
        recruiter_id=_recruiter_id_for_user(current_user),
    )
    return [ClientResponse.model_validate(c) for c in clients]


@router.get("/{client_id}", response_model=ClientResponse)
def get_client(
    client_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CLIENTS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> ClientResponse:
    service = ClientService(db)
    client = service.get_client_by_id(
        client_id=client_id,
        organization_id=UUID(current_user.organization_id),
        recruiter_id=_recruiter_id_for_user(current_user),
    )
    return ClientResponse.model_validate(client)


@router.put("/{client_id}", response_model=ClientResponse)
def update_client(
    client_id: UUID,
    payload: ClientUpdate,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CLIENTS_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> ClientResponse:
    service = ClientService(db)
    client = service.update_client(
        client_id=client_id,
        organization_id=UUID(current_user.organization_id),
        payload=payload,
        requester_id=UUID(current_user.user_id),
    )
    return ClientResponse.model_validate(client)


@router.delete("/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_client(
    client_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CLIENTS_DELETE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> None:
    service = ClientService(db)
    service.soft_delete_client(
        client_id=client_id,
        organization_id=UUID(current_user.organization_id),
        deleted_by=UUID(current_user.user_id),
    )


# ── Recruiter assignment endpoints ────────────────────────────────────────────


class AssignRecruitersPayload(BaseModel):
    recruiter_ids: list[UUID]


@router.get("/{client_id}/available-recruiters", response_model=list[RecruiterUserResponse])
def list_available_recruiters(
    client_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(CLIENTS_ASSIGN, CLIENTS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> list[RecruiterUserResponse]:
    """Return all recruiter-role users in the org suitable for assignment to this client.

    Used to populate the assignment dropdown UI. Requires ``clients:assign`` or
    ``clients:read``. Excludes admins and vendors — only assignable roles.
    """
    service = ClientService(db)
    # Verify the client exists and caller has access to it before exposing the user list.
    service.get_client_by_id(
        client_id=client_id,
        organization_id=UUID(current_user.organization_id),
        recruiter_id=_recruiter_id_for_user(current_user),
    )
    return service.list_available_recruiters(
        organization_id=UUID(current_user.organization_id),
    )


@router.get("/{client_id}/recruiters", response_model=list[ClientRecruiterResponse])
def list_client_recruiters(
    client_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_permission(CLIENTS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> list[ClientRecruiterResponse]:
    """List recruiters currently assigned to a client."""
    service = ClientService(db)
    return service.list_assigned_recruiters(
        client_id=client_id,
        organization_id=UUID(current_user.organization_id),
    )


@router.post("/{client_id}/recruiters", response_model=list[ClientRecruiterResponse])
def assign_recruiters(
    client_id: UUID,
    payload: AssignRecruitersPayload,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(CLIENTS_ASSIGN, CLIENTS_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> list[ClientRecruiterResponse]:
    """Assign one or more recruiters to a client workspace.

    Requires ``clients:assign`` or ``clients:update``.  Idempotent — already
    assigned recruiters are silently skipped.
    """
    service = ClientService(db)
    return service.assign_recruiters(
        client_id=client_id,
        organization_id=UUID(current_user.organization_id),
        recruiter_ids=payload.recruiter_ids,
        assigned_by=UUID(current_user.user_id),
    )


@router.delete("/{client_id}/recruiters/{recruiter_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_recruiter(
    client_id: UUID,
    recruiter_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(CLIENTS_ASSIGN, CLIENTS_UPDATE))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> None:
    """Remove a recruiter from a client workspace."""
    service = ClientService(db)
    service.remove_recruiter(
        client_id=client_id,
        organization_id=UUID(current_user.organization_id),
        recruiter_id=recruiter_id,
    )
