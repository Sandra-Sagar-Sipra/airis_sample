from __future__ import annotations

import logging
from datetime import datetime, timezone
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import Select, or_, select
from sqlalchemy.orm import Session

from app.models.candidate import Candidate
from app.models.pipeline import Pipeline
from app.schemas.auth import CurrentUser
from app.schemas.candidate import CandidateCreate, CandidateUpdate
from app.services.access_scope_service import AccessScopeService
from app.services.candidate_pipeline_withdrawal import withdraw_active_pipelines_for_candidate

logger = logging.getLogger(__name__)


class CandidateService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self._scope = AccessScopeService(db)

    def create_candidate(
        self,
        organization_id: UUID,
        payload: CandidateCreate,
        *,
        current_user: CurrentUser | None = None,
        auto_commit: bool = True,
    ) -> Candidate:
        """
        Create a candidate.

        Security: vendor access is enforced in query filters (list/get) by scoping to `created_by`.
        """
        created_by = UUID(current_user.user_id) if current_user is not None else None
        source_type = "vendor" if (current_user is not None and (current_user.role or "").strip().lower() == "vendor") else "internal"

        candidate = Candidate(
            organization_id=organization_id,
            first_name=payload.first_name.strip(),
            last_name=payload.last_name.strip(),
            email=str(payload.email).lower(),
            phone=payload.phone,
            location=payload.location,
            experience_summary=payload.experience_summary,
            education=payload.education,
            notes=payload.notes,
            created_by=created_by,
            source_type=source_type,
        )
        self.db.add(candidate)
        if auto_commit:
            self.db.commit()
        else:
            self.db.flush()
        self.db.refresh(candidate)
        return candidate

    def list_candidates(
        self,
        organization_id: UUID,
        current_user: CurrentUser,
        limit: int = 50,
        offset: int = 0,
    ) -> list[Candidate]:
        stmt: Select[tuple[Candidate]] = (
            select(Candidate)
            .where(
                or_(
                    Candidate.organization_id == organization_id,
                    Candidate.org_id == organization_id,
                ),
                Candidate.is_deleted.is_(False),
                Candidate.deleted_at.is_(None),
            )
            .order_by(Candidate.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
        if self._scope.is_client_user(current_user):
            stmt = stmt.where(
                Candidate.id.in_(
                    select(Pipeline.candidate_id).where(
                        Pipeline.job_id.in_(self._scope.allowed_job_ids_subquery(current_user))
                    )
                )
            )
        elif self._scope.is_vendor_user(current_user):
            # Vendors can see only candidates they submitted.
            stmt = stmt.where(Candidate.created_by == UUID(current_user.user_id))
        return list(self.db.scalars(stmt))

    def get_candidate_by_id(
        self,
        candidate_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        *,
        include_archived: bool = False,
    ) -> Candidate:
        stmt: Select[tuple[Candidate]] = select(Candidate).where(
            Candidate.id == candidate_id,
            or_(
                Candidate.organization_id == organization_id,
                Candidate.org_id == organization_id,
            ),
        )
        if not include_archived:
            stmt = stmt.where(
                Candidate.is_deleted.is_(False),
                Candidate.deleted_at.is_(None),
            )
        if self._scope.is_client_user(current_user):
            stmt = stmt.where(
                Candidate.id.in_(
                    select(Pipeline.candidate_id).where(
                        Pipeline.job_id.in_(self._scope.allowed_job_ids_subquery(current_user))
                    )
                )
            )
        elif self._scope.is_vendor_user(current_user):
            stmt = stmt.where(Candidate.created_by == UUID(current_user.user_id))
        candidate = self.db.scalar(stmt)
        if candidate is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Candidate not found.",
            )
        return candidate

    def update_candidate(
        self,
        candidate_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
        payload: CandidateUpdate,
    ) -> Candidate:
        candidate = self.get_candidate_by_id(candidate_id, organization_id, current_user)

        update_data = payload.model_dump(exclude_unset=True)
        if "email" in update_data and update_data["email"] is not None:
            update_data["email"] = str(update_data["email"]).lower()

        for field, value in update_data.items():
            setattr(candidate, field, value)

        self.db.add(candidate)
        self.db.commit()
        self.db.refresh(candidate)
        return candidate

    def _get_candidate_row_for_mutation(
        self,
        candidate_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> Candidate:
        stmt: Select[tuple[Candidate]] = select(Candidate).where(
            Candidate.id == candidate_id,
            or_(
                Candidate.organization_id == organization_id,
                Candidate.org_id == organization_id,
            ),
            Candidate.is_deleted.is_(False),
            Candidate.deleted_at.is_(None),
        )
        if self._scope.is_client_user(current_user):
            stmt = stmt.where(
                Candidate.id.in_(
                    select(Pipeline.candidate_id).where(
                        Pipeline.job_id.in_(self._scope.allowed_job_ids_subquery(current_user))
                    )
                )
            )
        elif self._scope.is_vendor_user(current_user):
            stmt = stmt.where(Candidate.created_by == UUID(current_user.user_id))
        candidate = self.db.scalar(stmt)
        if candidate is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Candidate not found.",
            )
        return candidate

    def archive_candidate(
        self,
        candidate_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> None:
        """AIR-510: Archive legacy candidate row (is_deleted + deleted_at)."""
        candidate = self._get_candidate_row_for_mutation(candidate_id, organization_id, current_user)
        now = datetime.now(timezone.utc)
        candidate.is_deleted = True
        candidate.deleted_at = now
        self.db.add(candidate)
        withdraw_active_pipelines_for_candidate(
            self.db,
            candidate_id=candidate.id,
            organization_id=organization_id,
            actor_user_id=UUID(current_user.user_id) if current_user.user_id else None,
            reason="Candidate archived",
        )
        self.db.commit()

    def hard_delete_candidate(
        self,
        candidate_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> None:
        """Permanent hard delete — removes candidate and all dependent ATS/pipeline data."""
        from app.candidate_management.models import Candidate as CmCandidate
        from app.services.candidate_hard_delete import (
            delete_candidate_row,
            purge_candidate_dependents,
            refresh_job_match_caches,
        )

        candidate = self._get_candidate_row_for_mutation(candidate_id, organization_id, current_user)
        cid = candidate.id
        workspace_id = self.db.scalar(
            select(CmCandidate.workspace_id).where(
                CmCandidate.id == cid,
                CmCandidate.org_id == organization_id,
            )
        ) or organization_id

        job_ids = purge_candidate_dependents(self.db, candidate_id=cid, organization_id=organization_id)
        deleted = delete_candidate_row(
            self.db,
            org_id=organization_id,
            workspace_id=workspace_id,
            candidate_id=cid,
        )
        if deleted == 0:
            self.db.delete(candidate)
        refresh_job_match_caches(self.db, organization_id=organization_id, job_ids=job_ids)
        """Permanent hard delete — removes candidate row and dependent pipeline rows."""
        import sqlalchemy as sa
        from app.models.application import Application
        from app.models.job_submission import JobSubmission

        candidate = self._get_candidate_row_for_mutation(candidate_id, organization_id, current_user)
        cid = candidate.id

        def _safe_delete(model: type) -> None:
            try:
                with self.db.begin_nested():
                    self.db.execute(sa.delete(model).where(model.candidate_id == cid))
            except Exception as e:
                logger.warning("hard_delete skip %s: %s", model.__name__, e)

        _safe_delete(Pipeline)
        _safe_delete(Application)
        _safe_delete(JobSubmission)
        self.db.delete(candidate)
        self.db.commit()

    def restore_candidate(
        self,
        candidate_id: UUID,
        organization_id: UUID,
        current_user: CurrentUser,
    ) -> Candidate:
        """AIR-512: Admin restore for legacy API consumers."""
        if (current_user.role or "").strip().lower() not in {"admin", "agency_admin"}:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required.")
        stmt: Select[tuple[Candidate]] = select(Candidate).where(
            Candidate.id == candidate_id,
            or_(
                Candidate.organization_id == organization_id,
                Candidate.org_id == organization_id,
            ),
        )
        candidate = self.db.scalar(stmt)
        if candidate is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Candidate not found.")
        if not candidate.is_deleted and candidate.deleted_at is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Candidate is not deleted.",
            )
        candidate.is_deleted = False
        candidate.deleted_at = None
        self.db.add(candidate)
        self.db.commit()
        self.db.refresh(candidate)
        return candidate

