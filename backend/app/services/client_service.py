from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.client import Client
from app.models.client_recruiter_assignment import ClientRecruiterAssignment
from app.models.profile import Profile
from app.schemas.client import ClientCreate, ClientRecruiterResponse, ClientUpdate, RecruiterUserResponse


class ClientService:
    def __init__(self, db: Session) -> None:
        self.db = db

    # ── helpers ──────────────────────────────────────────────────────────────

    def _assert_unique_name(self, organization_id: UUID, name: str, exclude_id: UUID | None = None) -> None:
        """Raise 409 if another non-deleted client in this org has the same name (case-insensitive)."""
        stmt = select(Client).where(
            Client.organization_id == organization_id,
            func.lower(Client.name) == name.strip().lower(),
            Client.is_deleted.is_(False),
        )
        if exclude_id is not None:
            stmt = stmt.where(Client.id != exclude_id)
        existing = self.db.scalar(stmt)
        if existing is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "error": "CLIENT_NAME_CONFLICT",
                    "message": f"A client named '{name.strip()}' already exists in this organization.",
                },
            )

    def _get_assigned_recruiter_ids(self, client_id: UUID) -> list[UUID]:
        rows = self.db.scalars(
            select(ClientRecruiterAssignment.recruiter_id).where(
                ClientRecruiterAssignment.client_id == client_id
            )
        ).all()
        return list(rows)

    def _enrich(self, client: Client) -> Client:
        """Attach assigned_recruiter_ids as a transient attribute for schema serialization."""
        client.__dict__["assigned_recruiter_ids"] = self._get_assigned_recruiter_ids(client.id)
        return client

    # ── public API ────────────────────────────────────────────────────────────

    def create_client(
        self,
        organization_id: UUID,
        payload: ClientCreate,
        created_by: UUID | None = None,
    ) -> Client:
        self._assert_unique_name(organization_id, payload.name)

        client = Client(
            organization_id=organization_id,
            name=payload.name.strip(),
            legal_name=payload.legal_name,
            industry=payload.industry,
            website=payload.website,
            email=str(payload.email).lower() if payload.email else None,
            phone=payload.phone,
            location=payload.location,
            notes=payload.notes,
        )
        self.db.add(client)
        self.db.flush()  # get client.id before assigning recruiters

        for recruiter_id in payload.assigned_recruiter_ids:
            self.db.add(
                ClientRecruiterAssignment(
                    client_id=client.id,
                    recruiter_id=recruiter_id,
                    assigned_by=created_by,
                )
            )

        self.db.commit()
        self.db.refresh(client)
        return self._enrich(client)

    def list_clients(
        self,
        organization_id: UUID,
        limit: int = 50,
        offset: int = 0,
        recruiter_id: UUID | None = None,
    ) -> list[Client]:
        """Return active clients scoped to org. When recruiter_id is given only return assigned clients."""
        stmt = select(Client).where(
            Client.organization_id == organization_id,
            Client.is_deleted.is_(False),
        )
        if recruiter_id is not None:
            assigned_client_ids = self.db.scalars(
                select(ClientRecruiterAssignment.client_id).where(
                    ClientRecruiterAssignment.recruiter_id == recruiter_id
                )
            ).all()
            stmt = stmt.where(Client.id.in_(assigned_client_ids))

        stmt = stmt.order_by(Client.created_at.desc()).offset(offset).limit(limit)
        return [self._enrich(c) for c in self.db.scalars(stmt)]

    def get_client_by_id(
        self,
        client_id: UUID,
        organization_id: UUID,
        recruiter_id: UUID | None = None,
    ) -> Client:
        stmt = select(Client).where(
            Client.id == client_id,
            Client.organization_id == organization_id,
            Client.is_deleted.is_(False),
        )
        client = self.db.scalar(stmt)
        if client is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Client not found.")

        if recruiter_id is not None:
            assigned = self.db.scalar(
                select(ClientRecruiterAssignment).where(
                    ClientRecruiterAssignment.client_id == client_id,
                    ClientRecruiterAssignment.recruiter_id == recruiter_id,
                )
            )
            if assigned is None:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")

        return self._enrich(client)

    def update_client(
        self,
        client_id: UUID,
        organization_id: UUID,
        payload: ClientUpdate,
        requester_id: UUID | None = None,
    ) -> Client:
        client = self.get_client_by_id(client_id, organization_id)

        update_data = payload.model_dump(exclude_unset=True)
        if "name" in update_data and update_data["name"] is not None:
            new_name = str(update_data["name"]).strip()
            self._assert_unique_name(organization_id, new_name, exclude_id=client_id)
            update_data["name"] = new_name
        if "email" in update_data and update_data["email"] is not None:
            update_data["email"] = str(update_data["email"]).lower()

        for field, value in update_data.items():
            setattr(client, field, value)

        self.db.add(client)
        self.db.commit()
        self.db.refresh(client)
        return self._enrich(client)

    def soft_delete_client(
        self,
        client_id: UUID,
        organization_id: UUID,
        deleted_by: UUID | None = None,
    ) -> None:
        client = self.get_client_by_id(client_id, organization_id)
        client.is_deleted = True
        client.deleted_at = datetime.now(timezone.utc)
        client.deleted_by = deleted_by
        self.db.add(client)
        self.db.commit()

    # ── recruiter assignment ───────────────────────────────────────────────────

    def assign_recruiters(
        self,
        client_id: UUID,
        organization_id: UUID,
        recruiter_ids: list[UUID],
        assigned_by: UUID | None = None,
    ) -> list[ClientRecruiterResponse]:
        """Idempotently assign recruiters; skip already-assigned ones."""
        self.get_client_by_id(client_id, organization_id)  # auth + existence check

        existing = set(
            self.db.scalars(
                select(ClientRecruiterAssignment.recruiter_id).where(
                    ClientRecruiterAssignment.client_id == client_id
                )
            ).all()
        )
        for rid in recruiter_ids:
            if rid not in existing:
                self.db.add(
                    ClientRecruiterAssignment(
                        client_id=client_id,
                        recruiter_id=rid,
                        assigned_by=assigned_by,
                    )
                )
        self.db.commit()
        return self.list_assigned_recruiters(client_id, organization_id)

    def remove_recruiter(
        self,
        client_id: UUID,
        organization_id: UUID,
        recruiter_id: UUID,
    ) -> None:
        self.get_client_by_id(client_id, organization_id)
        row = self.db.scalar(
            select(ClientRecruiterAssignment).where(
                ClientRecruiterAssignment.client_id == client_id,
                ClientRecruiterAssignment.recruiter_id == recruiter_id,
            )
        )
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Assignment not found.")
        self.db.delete(row)
        self.db.commit()

    def list_assigned_recruiters(
        self,
        client_id: UUID,
        organization_id: UUID,
    ) -> list[ClientRecruiterResponse]:
        """Return assigned recruiters enriched with email and role from profiles."""
        self.get_client_by_id(client_id, organization_id)
        rows = self.db.execute(
            select(
                ClientRecruiterAssignment.recruiter_id,
                ClientRecruiterAssignment.assigned_at,
                ClientRecruiterAssignment.assigned_by,
                Profile.email,
                Profile.role,
            )
            .outerjoin(Profile, Profile.id == ClientRecruiterAssignment.recruiter_id)
            .where(ClientRecruiterAssignment.client_id == client_id)
            .order_by(Profile.email.asc())
        ).all()
        return [
            ClientRecruiterResponse(
                recruiter_id=row.recruiter_id,
                assigned_at=row.assigned_at,
                assigned_by=row.assigned_by,
                email=row.email,
                role=row.role,
            )
            for row in rows
        ]

    def list_available_recruiters(
        self,
        organization_id: UUID,
    ) -> list[RecruiterUserResponse]:
        """Return all recruiter-role users in the org for the assignment dropdown.

        Excludes admin and vendor roles — only meaningful assignment targets.
        """
        stmt = (
            select(Profile)
            .where(
                Profile.organization_id == organization_id,
                Profile.role.notin_(["admin", "superadmin", "vendor"]),
            )
            .order_by(Profile.email.asc())
        )
        profiles = self.db.scalars(stmt).all()
        return [
            RecruiterUserResponse(
                id=str(p.id),
                email=p.email,
                role=p.role,
            )
            for p in profiles
        ]
