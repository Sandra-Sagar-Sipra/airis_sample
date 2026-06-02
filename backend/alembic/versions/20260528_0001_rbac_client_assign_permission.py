"""RBAC: add clients:assign permission; seed full clients:* set for admin role.

Fixes:
  WS-BUG-02  Admin role was missing clients:read/create/update/delete in
             role_permissions, causing the Clients menu item to be hidden.
  WS-BUG-03  New clients:assign permission separates recruiter-assignment
             authority from the generic clients:update permission, enabling
             fine-grained delegation.

Revision ID: 20260528_0001
Revises:     20260520_0003
Create Date: 2026-05-28
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260528_0001"
down_revision: str = "20260520_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Full set of client permissions (including the new clients:assign).
_CLIENT_PERMISSIONS: tuple[tuple[str, str, str], ...] = (
    ("clients:read",   "clients", "Clients Read"),
    ("clients:create", "clients", "Clients Create"),
    ("clients:update", "clients", "Clients Update"),
    ("clients:delete", "clients", "Clients Delete"),
    ("clients:assign", "clients", "Clients Assign Recruiters"),
)


def upgrade() -> None:
    bind = op.get_bind()

    # 1. Upsert permission catalog entries.
    for code, module, display in _CLIENT_PERMISSIONS:
        bind.execute(
            sa.text(
                """
                INSERT INTO permissions (code, module, display_name)
                VALUES (:code, :module, :display_name)
                ON CONFLICT (code) DO UPDATE
                  SET module = EXCLUDED.module,
                      display_name = EXCLUDED.display_name
                """
            ),
            {"code": code, "module": module, "display_name": display},
        )

    # 2. Assign ALL client permissions to every admin role in every org.
    #    ON CONFLICT DO NOTHING is idempotent — safe to re-run.
    client_perms_list = ", ".join(f"('{c}')" for c, _, __ in _CLIENT_PERMISSIONS)
    bind.execute(
        sa.text(
            f"""
            INSERT INTO role_permissions (organization_id, role_id, permission)
            SELECT r.organization_id, r.id, p.permission
            FROM organization_roles r
            CROSS JOIN (VALUES {client_perms_list}) AS p(permission)
            WHERE lower(r.key) IN ('admin', 'superadmin')
            ON CONFLICT (organization_id, role_id, permission) DO NOTHING
            """
        )
    )

    # 3. Grant clients:read to recruiter role so they can see the Clients
    #    menu and access their assigned workspaces.
    bind.execute(
        sa.text(
            """
            INSERT INTO role_permissions (organization_id, role_id, permission)
            SELECT r.organization_id, r.id, 'clients:read'
            FROM organization_roles r
            WHERE lower(r.key) = 'recruiter'
            ON CONFLICT (organization_id, role_id, permission) DO NOTHING
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    codes = tuple(c for c, _, __ in _CLIENT_PERMISSIONS)
    placeholders = ", ".join(f"'{c}'" for c in codes)
    bind.execute(
        sa.text(f"DELETE FROM role_permissions WHERE permission IN ({placeholders})")
    )
    bind.execute(
        sa.text(f"DELETE FROM permissions WHERE code IN ({placeholders})")
    )
