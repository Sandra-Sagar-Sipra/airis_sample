from __future__ import annotations
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError, IntegrityError
from sqlalchemy.orm import Session

from app.candidate_management.models import (
    BulkUploadItem,
    BulkUploadItemStatus,
    BulkUploadJob,
    BulkUploadStatus,
    Candidate,
    CandidateAuditLog,
    CandidateInteraction,
    CandidateParseStatus,
    CandidateSkill,
    CandidateSource,
    CandidateStatus,
    InteractionType,
)
from app.candidate_management.repository import CandidateRepository, CandidateSearchFilters
from app.candidate_management.search import normalize_search_query
from app.candidate_management.schemas import (
    CandidateAssignRecruiterRequest,
    CandidateBulkAssignRecruiterRequest,
    CandidateBulkDeleteRequest,
    CandidateBulkStageUpdateRequest,
    BulkUploadRequest,
    CandidateCreate,
    CandidateSkillInput,
    CandidateUpdate,
    InteractionCreate,
    InteractionTypeSchema,
    MergeCandidatesRequest,
    ResumeParseResult,
    ResumeUploadRequest,
)
from app.models.pipeline import Pipeline
from app.services.candidate_pipeline_withdrawal import withdraw_active_pipelines_for_candidate
from app.models.application import Application
from app.models.job import Job
from app.services.task_runner import dispatch_task

logger = logging.getLogger(__name__)


class AIServicePort(Protocol):
    def parse_resume(self, *, resume_s3_key: str) -> ResumeParseResult: ...

    def smart_search(self, *, query: str, org_id: UUID, workspace_id: UUID, limit: int) -> list[UUID]: ...


class TaskEnqueuerPort(Protocol):
    def enqueue_bulk_upload_item(self, *, job_id: UUID, item_id: UUID, org_id: UUID, workspace_id: UUID) -> None: ...


@dataclass(slots=True)
class SearchParams:
    query: str | None = None
    search_mode: str = "fast"
    skills: list[str] | None = None
    location: str | None = None
    min_years_experience: int | None = None
    max_years_experience: int | None = None
    status: str | None = None
    stage: str | None = None
    source: str | None = None
    job_id: UUID | None = None
    candidate_ids: list[UUID] | None = None
    limit: int = 50
    offset: int = 0


class CandidateManagementService:
    def __init__(
        self,
        db: Session,
        *,
        repository: CandidateRepository | None = None,
        ai_service: AIServicePort | None = None,
        task_enqueuer: TaskEnqueuerPort | None = None,
    ) -> None:
        self.db = db
        self.repository = repository or CandidateRepository(db)
        self.ai_service = ai_service
        self.task_enqueuer = task_enqueuer

    # -------------------------------
    # Candidate lifecycle
    # -------------------------------
    def create_candidate(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
        payload: CandidateCreate,
    ) -> Candidate:
        normalized_email = str(payload.email).lower() if payload.email else None
        duplicate = self.repository.find_duplicate_candidate(
            org_id=org_id,
            workspace_id=workspace_id,
            email=normalized_email,
            phone=payload.phone,
        )
        if duplicate is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "error": "DUPLICATE_CANDIDATE",
                    "existing_candidate_id": str(duplicate.id),
                },
            )

        first_name = self._sanitize_text(payload.first_name).strip()
        last_name = self._sanitize_text(payload.last_name).strip()
        full_name = self._sanitize_text(payload.full_name or f"{first_name} {last_name}").strip()

        candidate = Candidate(
            org_id=org_id,
            workspace_id=workspace_id,
            first_name=first_name,
            last_name=last_name,
            full_name=full_name,
            email=normalized_email,
            phone=self._normalized_optional_phone(payload.phone),
            location=self._optional_str(payload.location),
            years_experience=payload.years_experience,
            headline=self._optional_str(payload.headline),
            summary=self._optional_str(payload.summary),
            source=CandidateSource(payload.source.value),
            stage=payload.stage.value,
            job_id=getattr(payload, "job_id", None),
            recruiter_id=payload.recruiter_id,
            resume_s3_key=self._optional_str(payload.resume_s3_key),
            resume_file_name=self._optional_str(payload.resume_file_name),
            parse_confidence=payload.parse_confidence,
            parsed_resume_data=self._sanitize_json_value(payload.parsed_resume_data),
            created_by=actor_user_id,
            updated_by=actor_user_id,
            status=CandidateStatus.ACTIVE,
        )
        self.repository.create_candidate(candidate)
        if payload.skills:
            self.repository.add_candidate_skills(
                self._build_skills(
                    org_id=org_id,
                    workspace_id=workspace_id,
                    candidate_id=candidate.id,
                    skills=payload.skills,
                )
            )
        self._insert_audit_log(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate.id,
            actor_user_id=actor_user_id,
            actor_role=actor_role,
            action="candidate_created",
            field_name="candidate",
            old_value=None,
            new_value={"candidate_id": str(candidate.id)},
        )
        self._sync_candidate_pipeline(candidate=candidate, actor_user_id=actor_user_id)
        self.db.commit()
        return self._require_candidate(org_id=org_id, workspace_id=workspace_id, candidate_id=candidate.id)

    def create_candidate_from_resume(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
        request: ResumeUploadRequest,
    ) -> tuple[Candidate, ResumeParseResult]:
        if self.ai_service is None:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="AI service is unavailable.")

        # Resume parsing lifecycle: pending -> processing -> completed/failed.
        # We capture failures in `parse_error` so the UI can surface them.
        try:
            parse_result = self.ai_service.parse_resume(resume_s3_key=request.resume_s3_key)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Resume parser raised: %s", exc)
            self._mark_resume_parse_failed(
                org_id=org_id,
                workspace_id=workspace_id,
                candidate_id=request.candidate_id,
                error=str(exc),
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={"error": "RESUME_PARSE_FAILED", "message": str(exc)[:500]},
            ) from exc
        parsed = self._sanitize_json_value(parse_result.parsed_resume_data or {})
        parsed_email = self._normalized_optional_email(parsed.get("email"))
        parsed_phone = self._normalized_optional_phone(parsed.get("phone"))

        duplicate = self.repository.find_duplicate_candidate(
            org_id=org_id,
            workspace_id=workspace_id,
            email=parsed_email,
            phone=parsed_phone,
            exclude_candidate_id=request.candidate_id,
        )
        if duplicate is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "error": "DUPLICATE_CANDIDATE",
                    "existing_candidate_id": str(duplicate.id),
                },
            )

        if request.candidate_id:
            existing = self.repository.get_candidate_by_id(
                org_id=org_id,
                workspace_id=workspace_id,
                candidate_id=request.candidate_id,
                include_deleted=False,
                with_skills=False,
            )
            if existing is not None:
                candidate = existing
                updates: dict[str, Any] = {
                    "resume_s3_key": self._optional_str(request.resume_s3_key),
                    "resume_file_name": self._optional_str(request.resume_file_name),
                    "resume_uploaded_at": datetime.now(timezone.utc),
                    "parse_confidence": parse_result.parse_confidence,
                    "ai_parse_version": parse_result.ai_parse_version,
                    "parsed_resume_data": parsed,
                    "parse_status": CandidateParseStatus.COMPLETED,
                    "parse_error": None,
                    "parsed_at": datetime.now(timezone.utc),
                    "updated_by": actor_user_id,
                }
                self.repository.update_candidate_fields(candidate, updates)
            else:
                # Allow caller-provided candidate UUID for create flows so storage
                # keys can follow resumes/{org_id}/{candidate_id}/...
                full_name = str(parsed.get("full_name") or "").strip()
                first_name = str(parsed.get("first_name") or "").strip() or (full_name.split(" ")[0] if full_name else "Unknown")
                last_name = str(parsed.get("last_name") or "").strip() or (
                    " ".join(full_name.split(" ")[1:]) if full_name and " " in full_name else "Candidate"
                )
                candidate = Candidate(
                    id=request.candidate_id,
                    org_id=org_id,
                    workspace_id=workspace_id,
                    first_name=first_name,
                    last_name=last_name,
                    full_name=full_name or f"{first_name} {last_name}",
                    email=parsed_email,
                    phone=parsed_phone,
                    location=self._optional_str(parsed.get("location")),
                    years_experience=self._optional_int(parsed.get("years_experience")),
                    headline=self._optional_str(parsed.get("headline")),
                    summary=self._optional_str(parsed.get("summary")),
                    source=CandidateSource.RESUME_UPLOAD,
                    stage="applied",
                    resume_s3_key=self._optional_str(request.resume_s3_key),
                    resume_file_name=self._optional_str(request.resume_file_name),
                    resume_uploaded_at=datetime.now(timezone.utc),
                    parse_confidence=parse_result.parse_confidence,
                    ai_parse_version=parse_result.ai_parse_version,
                    parsed_resume_data=parsed,
                    parse_status=CandidateParseStatus.COMPLETED,
                    parse_error=None,
                    parsed_at=datetime.now(timezone.utc),
                    created_by=actor_user_id,
                    updated_by=actor_user_id,
                    status=CandidateStatus.ACTIVE,
                )
                self.repository.create_candidate(candidate)
        else:
            full_name = str(parsed.get("full_name") or "").strip()
            first_name = str(parsed.get("first_name") or "").strip() or (full_name.split(" ")[0] if full_name else "Unknown")
            last_name = str(parsed.get("last_name") or "").strip() or (
                " ".join(full_name.split(" ")[1:]) if full_name and " " in full_name else "Candidate"
            )
            candidate = Candidate(
                org_id=org_id,
                workspace_id=workspace_id,
                first_name=first_name,
                last_name=last_name,
                full_name=full_name or f"{first_name} {last_name}",
                email=parsed_email,
                phone=parsed_phone,
                location=self._optional_str(parsed.get("location")),
                years_experience=self._optional_int(parsed.get("years_experience")),
                headline=self._optional_str(parsed.get("headline")),
                summary=self._optional_str(parsed.get("summary")),
                source=CandidateSource.RESUME_UPLOAD,
                stage="applied",
                resume_s3_key=self._optional_str(request.resume_s3_key),
                resume_file_name=self._optional_str(request.resume_file_name),
                resume_uploaded_at=datetime.now(timezone.utc),
                parse_confidence=parse_result.parse_confidence,
                ai_parse_version=parse_result.ai_parse_version,
                parsed_resume_data=parsed,
                parse_status=CandidateParseStatus.COMPLETED,
                parse_error=None,
                parsed_at=datetime.now(timezone.utc),
                created_by=actor_user_id,
                updated_by=actor_user_id,
                status=CandidateStatus.ACTIVE,
            )
            self.repository.create_candidate(candidate)

        if parse_result.extracted_skills:
            self.repository.replace_candidate_skills(
                org_id=org_id,
                workspace_id=workspace_id,
                candidate_id=candidate.id,
                skills=self._build_skills(
                    org_id=org_id,
                    workspace_id=workspace_id,
                    candidate_id=candidate.id,
                    skills=parse_result.extracted_skills,
                ),
            )
        self._insert_audit_log(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate.id,
            actor_user_id=actor_user_id,
            actor_role=actor_role,
            action="resume_parsed",
            field_name="resume",
            old_value=None,
            new_value={
                "resume_s3_key": self._optional_str(request.resume_s3_key),
                "parse_confidence": parse_result.parse_confidence,
            },
        )
        self.db.commit()
        try:
            from app.candidate_management.tasks_ats import rescore_candidate_task, run_rescore_candidate

            dispatch_task(
                task=rescore_candidate_task,
                fallback=run_rescore_candidate,
                kwargs={
                    "organization_id": str(org_id),
                    "candidate_id": str(candidate.id),
                },
            )
        except Exception:
            logger.exception(
                "ats.dispatch_after_resume_failed",
                extra={
                    "ats_phase": "dispatch_rescore_candidate",
                    "organization_id": str(org_id),
                    "candidate_id": str(candidate.id),
                },
            )
        return self._require_candidate(org_id=org_id, workspace_id=workspace_id, candidate_id=candidate.id), parse_result

    def get_candidate(self, *, org_id: UUID, workspace_id: UUID, candidate_id: UUID) -> Candidate:
        """Detail/profile read — includes archived (soft-deleted) candidates."""
        return self._require_candidate(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate_id,
            include_archived=True,
        )

    def list_candidates(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        limit: int = 50,
        offset: int = 0,
        skills: list[str] | None = None,
        location: str | None = None,
        min_years_experience: int | None = None,
        max_years_experience: int | None = None,
        status: str | None = None,
        stage: str | None = None,
        source: str | None = None,
        job_id: UUID | None = None,
    ) -> tuple[list[Candidate], int]:
        filters = self._build_search_filters(
            skills=skills,
            location=location,
            min_years_experience=min_years_experience,
            max_years_experience=max_years_experience,
            status=status,
            stage=stage,
            source=source,
            job_id=job_id,
            candidate_ids=None,
        )
        candidates = self.repository.list_candidates(
            org_id=org_id,
            workspace_id=workspace_id,
            limit=limit,
            offset=offset,
            filters=filters,
            list_mode=True,
        )
        total = self.repository.count_candidates(org_id=org_id, workspace_id=workspace_id, filters=filters)
        return candidates, total

    def update_candidate(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
        payload: CandidateUpdate,
    ) -> Candidate:
        candidate = self._require_candidate(org_id=org_id, workspace_id=workspace_id, candidate_id=candidate_id)
        update_data = payload.model_dump(exclude_unset=True)
        old_values: dict[str, Any] = {}

        if "email" in update_data and update_data["email"] is not None:
            update_data["email"] = str(update_data["email"]).lower()
            duplicate = self.repository.find_duplicate_candidate(
                org_id=org_id,
                workspace_id=workspace_id,
                email=update_data["email"],
                phone=update_data.get("phone", candidate.phone),
                exclude_candidate_id=candidate.id,
            )
            if duplicate is not None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={"error": "DUPLICATE_CANDIDATE", "existing_candidate_id": str(duplicate.id)},
                )

        if "skills" in update_data and update_data["skills"] is not None:
            incoming_skills = update_data.pop("skills")
            self.repository.replace_candidate_skills(
                org_id=org_id,
                workspace_id=workspace_id,
                candidate_id=candidate.id,
                skills=self._build_skills(
                    org_id=org_id,
                    workspace_id=workspace_id,
                    candidate_id=candidate.id,
                    skills=incoming_skills,
                ),
            )

        update_data["updated_by"] = actor_user_id
        for field, value in update_data.items():
            if getattr(candidate, field, None) != value:
                old_values[field] = getattr(candidate, field, None)
        self.repository.update_candidate_fields(candidate, update_data)

        stage_changed = "stage" in update_data and old_values.get("stage") is not None and old_values["stage"] != candidate.stage
        if stage_changed:
            self.repository.create_interaction(
                CandidateInteraction(
                    org_id=org_id,
                    workspace_id=workspace_id,
                    candidate_id=candidate.id,
                    interaction_type=InteractionType.STAGE_CHANGE,
                    title="Candidate stage updated",
                    interaction_metadata={"from": old_values["stage"], "to": candidate.stage},
                    actor_user_id=actor_user_id,
                    actor_role=actor_role,
                )
            )

        for field, old_value in old_values.items():
            self._insert_audit_log(
                org_id=org_id,
                workspace_id=workspace_id,
                candidate_id=candidate.id,
                actor_user_id=actor_user_id,
                actor_role=actor_role,
                action="candidate_updated",
                field_name=field,
                old_value={"value": self._json_safe(old_value)},
                new_value={"value": self._json_safe(getattr(candidate, field))},
            )
        if "stage" in update_data or "job_id" in update_data:
            self._sync_candidate_pipeline(candidate=candidate, actor_user_id=actor_user_id)
        self.db.commit()
        return self._require_candidate(org_id=org_id, workspace_id=workspace_id, candidate_id=candidate.id)

    def _apply_soft_delete(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate: Candidate,
        actor_user_id: UUID | None,
        actor_role: str | None,
    ) -> None:
        """AIR-510/512/513: archive (soft-delete) one candidate, withdraw pipelines, audit."""
        deleted_at_before = candidate.deleted_at
        self.repository.soft_delete_candidate(candidate=candidate, deleted_by=actor_user_id)
        self.repository.update_candidate_fields(
            candidate,
            {"status": CandidateStatus.DELETED, "updated_by": actor_user_id},
        )
        withdraw_active_pipelines_for_candidate(
            self.db,
            candidate_id=candidate.id,
            organization_id=org_id,
            actor_user_id=actor_user_id,
            reason="Candidate removed",
        )
        self._insert_audit_log(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate.id,
            actor_user_id=actor_user_id,
            actor_role=actor_role,
            action="candidate_archived",
            field_name="is_deleted",
            old_value={"is_deleted": False, "deleted_at": deleted_at_before.isoformat() if deleted_at_before else None},
            new_value={
                "is_deleted": True,
                "deleted_at": candidate.deleted_at.isoformat() if candidate.deleted_at else None,
            },
        )
        self.repository.create_interaction(
            CandidateInteraction(
                org_id=org_id,
                workspace_id=workspace_id,
                candidate_id=candidate.id,
                interaction_type=InteractionType.SYSTEM,
                title="Candidate archived",
                interaction_metadata={"action": "archive"},
                actor_user_id=actor_user_id,
                actor_role=actor_role,
            )
        )

    def archive_candidate(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
    ) -> None:
        """AIR-510: Archive (soft-delete) — sets is_deleted, deleted_at, deleted_by."""
        candidate = self._require_candidate(org_id=org_id, workspace_id=workspace_id, candidate_id=candidate_id)
        self._apply_soft_delete(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate=candidate,
            actor_user_id=actor_user_id,
            actor_role=actor_role,
        )
        self.db.commit()

    def soft_delete_candidate(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
    ) -> None:
        """Backward-compatible alias for archive_candidate."""
        self.archive_candidate(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate_id,
            actor_user_id=actor_user_id,
            actor_role=actor_role,
        )

    def restore_candidate(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
    ) -> Candidate:
        """AIR-512: Admin restore — clears soft-delete flags (is_deleted / deleted_at)."""
        if not self._is_admin_role(actor_role):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required.")
        candidate = self.repository.get_candidate_by_id(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate_id,
            include_deleted=True,
        )
        if candidate is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Candidate not found.")
        if candidate.deleted_at is None and str(candidate.status) != CandidateStatus.DELETED.value:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Candidate is not deleted.",
            )
        deleted_at_before = candidate.deleted_at.isoformat() if candidate.deleted_at else None
        self.repository.restore_candidate(candidate=candidate)
        self.repository.update_candidate_fields(
            candidate,
            {"status": CandidateStatus.ACTIVE, "updated_by": actor_user_id},
        )
        self._insert_audit_log(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate.id,
            actor_user_id=actor_user_id,
            actor_role=actor_role,
            action="candidate_restored",
            field_name="is_deleted",
            old_value={"is_deleted": True, "deleted_at": deleted_at_before},
            new_value={"is_deleted": False, "deleted_at": None},
        )
        self.repository.create_interaction(
            CandidateInteraction(
                org_id=org_id,
                workspace_id=workspace_id,
                candidate_id=candidate.id,
                interaction_type=InteractionType.SYSTEM,
                title="Candidate restored",
                interaction_metadata={"action": "restore"},
                actor_user_id=actor_user_id,
                actor_role=actor_role,
            )
        )
        self.db.commit()
        return self._require_candidate(org_id=org_id, workspace_id=workspace_id, candidate_id=candidate.id)

    def hard_delete_candidate(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID,
    ) -> None:
        from app.services.candidate_hard_delete import (
            delete_candidate_row,
            purge_candidate_dependents,
            refresh_job_match_caches,
        )

        job_ids = purge_candidate_dependents(
            self.db,
            candidate_id=candidate_id,
            organization_id=org_id,
        )
        deleted_count = delete_candidate_row(
            self.db,
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate_id,
        )
        if deleted_count == 0:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Candidate not found.")
        refresh_job_match_caches(self.db, organization_id=org_id, job_ids=job_ids)
        self.db.commit()

    def bulk_update_stage(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
        payload: CandidateBulkStageUpdateRequest,
    ) -> int:
        try:
            parsed_ids: list[UUID] = [UUID(str(raw).strip()) for raw in payload.candidate_ids]
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid candidate_ids; each value must be a UUID string.",
            ) from exc

        unique_ids: list[UUID] = []
        seen: set[UUID] = set()
        for cid in parsed_ids:
            if cid not in seen:
                seen.add(cid)
                unique_ids.append(cid)

        new_stage = payload.stage.value
        try:
            candidates = self.repository.list_candidates_by_ids(
                org_id=org_id,
                workspace_id=workspace_id,
                candidate_ids=unique_ids,
                for_update=True,
            )
        except SQLAlchemyError:
            logger.exception("bulk_update_stage failed while loading candidates")
            self.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Database error while loading candidates.",
            ) from None

        if not candidates:
            self.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No candidates matched the provided ids.",
            )

        by_id = {c.id: c for c in candidates}
        updated = 0
        try:
            for candidate_id in unique_ids:
                candidate = by_id.get(candidate_id)
                if candidate is None:
                    continue
                old_stage = candidate.stage
                if old_stage == new_stage:
                    continue
                self.repository.update_candidate_fields(
                    candidate,
                    {"stage": new_stage, "updated_by": actor_user_id},
                )
                self._sync_candidate_pipeline(candidate=candidate, actor_user_id=actor_user_id)
                self.repository.create_interaction(
                    CandidateInteraction(
                        org_id=org_id,
                        workspace_id=workspace_id,
                        candidate_id=candidate.id,
                        interaction_type=InteractionType.STAGE_CHANGE,
                        title="Bulk stage update",
                        interaction_metadata={"from": old_stage, "to": new_stage},
                        actor_user_id=actor_user_id,
                        actor_role=actor_role,
                    )
                )
                updated += 1
            self.db.commit()
        except SQLAlchemyError:
            logger.exception("bulk_update_stage failed while applying updates")
            self.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Database error while saving bulk stage update.",
            ) from None
        return updated

    def bulk_soft_delete(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
        payload: CandidateBulkDeleteRequest,
    ) -> int:
        deleted = 0
        for candidate_id in payload.candidate_ids:
            candidate = self._require_candidate(org_id=org_id, workspace_id=workspace_id, candidate_id=candidate_id)
            self._apply_soft_delete(
                org_id=org_id,
                workspace_id=workspace_id,
                candidate=candidate,
                actor_user_id=actor_user_id,
                actor_role=actor_role,
            )
            deleted += 1
        self.db.commit()
        return deleted

    def bulk_hard_delete(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
        payload: CandidateBulkDeleteRequest,
    ) -> int:
        from app.services.candidate_hard_delete import (
            delete_candidate_row,
            purge_candidate_dependents,
            refresh_job_match_caches,
        )

        candidate_ids = payload.candidate_ids
        if not candidate_ids:
            return 0

        all_job_ids: set[UUID] = set()
        deleted_count = 0
        for candidate_id in candidate_ids:
            job_ids = purge_candidate_dependents(
                self.db,
                candidate_id=candidate_id,
                organization_id=org_id,
            )
            all_job_ids.update(job_ids)
            deleted_count += delete_candidate_row(
                self.db,
                org_id=org_id,
                workspace_id=workspace_id,
                candidate_id=candidate_id,
            )
        refresh_job_match_caches(self.db, organization_id=org_id, job_ids=all_job_ids)
        self.db.commit()
        return deleted_count

    def bulk_unarchive(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
        payload: CandidateBulkDeleteRequest,
    ) -> int:
        if not self._is_admin_role(actor_role):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required.")
        unarchived = 0
        for candidate_id in payload.candidate_ids:
            candidate = self.repository.get_candidate_by_id(
                org_id=org_id,
                workspace_id=workspace_id,
                candidate_id=candidate_id,
                include_deleted=True,
            )
            if candidate is None:
                continue
            if candidate.deleted_at is None and str(candidate.status) != CandidateStatus.DELETED.value:
                continue
            deleted_at_before = candidate.deleted_at.isoformat() if candidate.deleted_at else None
            self.repository.restore_candidate(candidate=candidate)
            self.repository.update_candidate_fields(
                candidate,
                {"status": CandidateStatus.ACTIVE, "updated_by": actor_user_id},
            )
            self._insert_audit_log(
                org_id=org_id,
                workspace_id=workspace_id,
                candidate_id=candidate.id,
                actor_user_id=actor_user_id,
                actor_role=actor_role,
                action="candidate_restored",
                field_name="is_deleted",
                old_value={"is_deleted": True, "deleted_at": deleted_at_before},
                new_value={"is_deleted": False, "deleted_at": None},
            )
            self.repository.create_interaction(
                CandidateInteraction(
                    org_id=org_id,
                    workspace_id=workspace_id,
                    candidate_id=candidate.id,
                    interaction_type=InteractionType.SYSTEM,
                    title="Candidate restored",
                    interaction_metadata={"action": "bulk_unarchive"},
                    actor_user_id=actor_user_id,
                    actor_role=actor_role,
                )
            )
            unarchived += 1
        self.db.commit()
        return unarchived

    def bulk_assign_recruiter(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
        payload: CandidateBulkAssignRecruiterRequest,
    ) -> int:
        updated = 0
        for candidate_id in payload.candidate_ids:
            candidate = self._require_candidate(org_id=org_id, workspace_id=workspace_id, candidate_id=candidate_id)
            old_recruiter = candidate.recruiter_id
            if old_recruiter == payload.recruiter_id:
                continue
            self.repository.update_candidate_fields(
                candidate,
                {"recruiter_id": payload.recruiter_id, "updated_by": actor_user_id},
            )
            self.repository.create_interaction(
                CandidateInteraction(
                    org_id=org_id,
                    workspace_id=workspace_id,
                    candidate_id=candidate.id,
                    interaction_type=InteractionType.SYSTEM,
                    title="Recruiter assigned",
                    interaction_metadata={
                        "from_recruiter_id": str(old_recruiter) if old_recruiter else None,
                        "to_recruiter_id": str(payload.recruiter_id),
                        "action": "bulk_assign_recruiter",
                    },
                    actor_user_id=actor_user_id,
                    actor_role=actor_role,
                )
            )
            updated += 1
        self.db.commit()
        return updated

    def assign_recruiter(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
        payload: CandidateAssignRecruiterRequest,
    ) -> Candidate:
        candidate = self._require_candidate(org_id=org_id, workspace_id=workspace_id, candidate_id=candidate_id)
        old_recruiter = candidate.recruiter_id
        self.repository.update_candidate_fields(
            candidate,
            {"recruiter_id": payload.recruiter_id, "updated_by": actor_user_id},
        )
        if old_recruiter != payload.recruiter_id:
            self.repository.create_interaction(
                CandidateInteraction(
                    org_id=org_id,
                    workspace_id=workspace_id,
                    candidate_id=candidate.id,
                    interaction_type=InteractionType.SYSTEM,
                    title="Recruiter reassigned",
                    interaction_metadata={
                        "from_recruiter_id": str(old_recruiter) if old_recruiter else None,
                        "to_recruiter_id": str(payload.recruiter_id),
                        "action": "assign_recruiter",
                    },
                    actor_user_id=actor_user_id,
                    actor_role=actor_role,
                )
            )
        self.db.commit()
        return self._require_candidate(org_id=org_id, workspace_id=workspace_id, candidate_id=candidate.id)

    # -------------------------------
    # Interactions and timeline
    # -------------------------------
    def add_interaction(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
        payload: InteractionCreate,
    ) -> CandidateInteraction:
        self._require_candidate(org_id=org_id, workspace_id=workspace_id, candidate_id=candidate_id)
        interaction = CandidateInteraction(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate_id,
            interaction_type=InteractionType(payload.interaction_type.value),
            title=payload.title,
            body=payload.body,
            interaction_metadata=payload.interaction_metadata,
            actor_user_id=actor_user_id,
            actor_role=actor_role,
        )
        self.repository.create_interaction(interaction)
        self.db.commit()
        return interaction

    def get_timeline(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID,
        limit: int,
        offset: int,
    ) -> list[CandidateInteraction]:
        # Avoid eager-loading skills: not needed for timeline and can fail on schema drift.
        self._require_candidate(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate_id,
            with_skills=False,
            include_archived=True,
        )
        return self.repository.list_interactions(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate_id,
            limit=limit,
            offset=offset,
        )

    # -------------------------------
    # Candidate notes (AIR-38) — note interactions with optional soft-hide
    # -------------------------------

    @staticmethod
    def _interaction_is_note(interaction: CandidateInteraction) -> bool:
        t = interaction.interaction_type
        if isinstance(t, InteractionType):
            return t == InteractionType.NOTE
        return str(t).lower() == InteractionType.NOTE.value

    @staticmethod
    def _note_is_hidden(metadata: dict[str, Any] | None) -> bool:
        return bool(isinstance(metadata, dict) and metadata.get("hidden") is True)

    @staticmethod
    def _is_admin_role(role: str | None) -> bool:
        return (role or "").strip().lower() in {"admin", "agency_admin"}

    def _interaction_to_note(
        self,
        interaction: CandidateInteraction,
        *,
        author_email: str | None = None,
    ) -> dict[str, Any]:
        from app.candidate_management.schemas import NoteResponse

        meta = interaction.interaction_metadata if isinstance(interaction.interaction_metadata, dict) else {}
        return NoteResponse(
            id=interaction.id,
            candidate_id=interaction.candidate_id,
            content=(interaction.body or "").strip(),
            author_user_id=interaction.actor_user_id,
            author_email=author_email,
            author_role=interaction.actor_role,
            created_at=interaction.created_at,
            hidden=self._note_is_hidden(meta),
        ).model_dump()

    def _author_emails_for_notes(
        self,
        interactions: list[CandidateInteraction],
        *,
        org_id: UUID,
    ) -> dict[UUID, str]:
        from app.models.profile import Profile

        user_ids = {i.actor_user_id for i in interactions if i.actor_user_id is not None}
        if not user_ids:
            return {}
        rows = self.db.execute(
            select(Profile.id, Profile.email).where(
                Profile.organization_id == org_id,
                Profile.id.in_(user_ids),
            )
        ).all()
        return {row[0]: row[1] for row in rows}

    def add_note(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID,
        actor_user_id: UUID,
        actor_role: str | None,
        content: str,
    ) -> dict[str, Any]:
        text = content.strip()
        if not text:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Note content cannot be empty.",
            )
        interaction = self.add_interaction(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate_id,
            actor_user_id=actor_user_id,
            actor_role=actor_role,
            payload=InteractionCreate(
                interaction_type=InteractionTypeSchema.NOTE,
                title="Candidate note",
                body=text,
            ),
        )
        email_map = self._author_emails_for_notes([interaction], org_id=org_id)
        return self._interaction_to_note(
            interaction,
            author_email=email_map.get(interaction.actor_user_id) if interaction.actor_user_id else None,
        )

    def list_notes(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID,
        viewer_role: str | None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        interactions = self.repository.list_interactions(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate_id,
            limit=500,
            offset=0,
        )
        notes_only = [i for i in interactions if self._interaction_is_note(i)]
        include_hidden = self._is_admin_role(viewer_role)
        if not include_hidden:
            notes_only = [i for i in notes_only if not self._note_is_hidden(i.interaction_metadata)]
        email_map = self._author_emails_for_notes(notes_only, org_id=org_id)
        items = [
            self._interaction_to_note(
                i,
                author_email=email_map.get(i.actor_user_id) if i.actor_user_id else None,
            )
            for i in notes_only
        ]
        total = len(items)
        page = items[offset : offset + limit]
        return page, total

    def soft_hide_note(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID,
        note_id: UUID,
        actor_user_id: UUID,
    ) -> dict[str, Any]:
        """AIR-508: Admin-only soft-hide — sets metadata.hidden on the note interaction."""
        interaction = self.repository.get_interaction_by_id(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate_id,
            interaction_id=note_id,
        )
        if interaction is None or not self._interaction_is_note(interaction):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found.")
        meta = dict(interaction.interaction_metadata or {})
        meta["hidden"] = True
        meta["hidden_at"] = datetime.now(timezone.utc).isoformat()
        meta["hidden_by"] = str(actor_user_id)
        interaction.interaction_metadata = meta
        self.db.add(interaction)
        self.db.commit()
        self.db.refresh(interaction)
        email_map = self._author_emails_for_notes([interaction], org_id=org_id)
        return self._interaction_to_note(
            interaction,
            author_email=email_map.get(interaction.actor_user_id) if interaction.actor_user_id else None,
        )

    # -------------------------------
    # Search
    # -------------------------------
    def search_candidates(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        params: SearchParams,
    ) -> tuple[list[Candidate], int]:
        text_query = normalize_search_query(params.query)
        use_semantic = (params.search_mode or "fast").strip().lower() == "semantic"

        if params.candidate_ids:
            filters = self._build_search_filters(
                text_query=text_query,
                skills=params.skills,
                location=params.location,
                min_years_experience=params.min_years_experience,
                max_years_experience=params.max_years_experience,
                status=params.status,
                stage=params.stage,
                source=params.source,
                job_id=params.job_id,
                candidate_ids=params.candidate_ids,
            )
            candidates = self.repository.list_candidates(
                org_id=org_id,
                workspace_id=workspace_id,
                limit=params.limit,
                offset=params.offset,
                filters=filters,
                list_mode=True,
            )
            total = self.repository.count_candidates(
                org_id=org_id,
                workspace_id=workspace_id,
                filters=filters,
            )
            return candidates, total

        if text_query and not use_semantic:
            filters = self._build_search_filters(
                text_query=text_query,
                skills=params.skills,
                location=params.location,
                min_years_experience=params.min_years_experience,
                max_years_experience=params.max_years_experience,
                status=params.status,
                stage=params.stage,
                source=params.source,
                job_id=params.job_id,
                candidate_ids=None,
            )
            candidates = self.repository.list_candidates(
                org_id=org_id,
                workspace_id=workspace_id,
                limit=params.limit,
                offset=params.offset,
                filters=filters,
                list_mode=True,
            )
            total = self.repository.count_candidates(
                org_id=org_id,
                workspace_id=workspace_id,
                filters=filters,
            )
            return candidates, total

        if text_query and use_semantic and self.ai_service is not None:
            ranked_ids = self.ai_service.smart_search(
                query=text_query,
                org_id=org_id,
                workspace_id=workspace_id,
                limit=max(params.limit + params.offset, params.limit),
            )
            if not ranked_ids:
                return [], 0

            include_del = (params.status == CandidateStatus.DELETED.value) if params.status else False
            loaded = self.repository.list_candidates_by_ids(
                org_id=org_id,
                workspace_id=workspace_id,
                candidate_ids=ranked_ids,
                include_deleted=include_del,
                with_skills=bool(params.skills),
                list_mode=True,
            )
            by_id = {candidate.id: candidate for candidate in loaded}
            hydrated = [by_id[candidate_id] for candidate_id in ranked_ids if candidate_id in by_id]

            filtered = self._apply_post_filters(
                hydrated,
                skills=params.skills,
                location=params.location,
                min_years_experience=params.min_years_experience,
                max_years_experience=params.max_years_experience,
                status=params.status,
                stage=params.stage,
                source=params.source,
                job_id=params.job_id,
            )
            total = len(filtered)
            return filtered[params.offset : params.offset + params.limit], total

        if text_query:
            filters = self._build_search_filters(
                text_query=text_query,
                skills=params.skills,
                location=params.location,
                min_years_experience=params.min_years_experience,
                max_years_experience=params.max_years_experience,
                status=params.status,
                stage=params.stage,
                source=params.source,
                job_id=params.job_id,
                candidate_ids=None,
            )
            candidates = self.repository.list_candidates(
                org_id=org_id,
                workspace_id=workspace_id,
                limit=params.limit,
                offset=params.offset,
                filters=filters,
                list_mode=True,
            )
            total = self.repository.count_candidates(
                org_id=org_id,
                workspace_id=workspace_id,
                filters=filters,
            )
            return candidates, total

        candidates, total = self.list_candidates(
            org_id=org_id,
            workspace_id=workspace_id,
            limit=params.limit,
            offset=params.offset,
            skills=params.skills,
            location=params.location,
            min_years_experience=params.min_years_experience,
            max_years_experience=params.max_years_experience,
            status=params.status,
            stage=params.stage,
            source=params.source,
            job_id=params.job_id,
        )
        return candidates, total

    def candidate_to_response_dict(self, candidate: Candidate, *, list_mode: bool = False) -> dict[str, Any]:
        """Build API-safe dict; list_mode avoids loading heavy JSONB fields."""
        data = self._normalize_candidate(candidate)
        if list_mode:
            data["parsed_resume_data"] = None
        return data

    def _build_search_filters(
        self,
        *,
        text_query: str | None = None,
        skills: list[str] | None,
        location: str | None,
        min_years_experience: int | None,
        max_years_experience: int | None,
        status: str | None,
        stage: str | None,
        source: str | None,
        job_id: UUID | None,
        candidate_ids: list[UUID] | None,
    ) -> CandidateSearchFilters:
        status_value = CandidateStatus(status) if status else None
        source_value = CandidateSource(source) if source else None
        return CandidateSearchFilters(
            text_query=text_query,
            skills=skills,
            location=location,
            min_years_experience=min_years_experience,
            max_years_experience=max_years_experience,
            status=status_value,
            stage=stage,
            source=source_value,
            job_id=job_id,
            candidate_ids=candidate_ids,
            include_deleted=status_value == CandidateStatus.DELETED,
        )

    # -------------------------------
    # Merge
    # -------------------------------
    def merge_candidates(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
        payload: MergeCandidatesRequest,
    ) -> Candidate:
        if payload.source_candidate_id == payload.target_candidate_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"error": "MERGE_CONFLICT"})

        source_candidate = self._require_candidate(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=payload.source_candidate_id,
        )
        target_candidate = self._require_candidate(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=payload.target_candidate_id,
        )

        fill_updates = {}
        for field in ("email", "phone", "location", "headline", "summary", "years_experience"):
            if getattr(target_candidate, field) is None and getattr(source_candidate, field) is not None:
                fill_updates[field] = getattr(source_candidate, field)
        if fill_updates:
            fill_updates["updated_by"] = actor_user_id
            self.repository.update_candidate_fields(target_candidate, fill_updates)

        self.repository.merge_candidate_skills(
            org_id=org_id,
            workspace_id=workspace_id,
            source_candidate_id=source_candidate.id,
            target_candidate_id=target_candidate.id,
        )

        # Interactions are append-only, so merge by cloning source timeline to target.
        source_interactions = self.repository.list_interactions(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=source_candidate.id,
            limit=10000,
            offset=0,
        )
        for event in source_interactions:
            self.repository.create_interaction(
                CandidateInteraction(
                    org_id=org_id,
                    workspace_id=workspace_id,
                    candidate_id=target_candidate.id,
                    interaction_type=event.interaction_type,
                    title=event.title,
                    body=event.body,
                    interaction_metadata=event.interaction_metadata,
                    actor_user_id=event.actor_user_id,
                    actor_role=event.actor_role,
                )
            )

        self.repository.reassign_bulk_upload_items_candidate(
            org_id=org_id,
            workspace_id=workspace_id,
            source_candidate_id=source_candidate.id,
            target_candidate_id=target_candidate.id,
        )
        self.repository.mark_candidate_as_merged(
            source_candidate=source_candidate,
            target_candidate_id=target_candidate.id,
            actor_user_id=actor_user_id,
        )
        self._insert_audit_log(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=target_candidate.id,
            actor_user_id=actor_user_id,
            actor_role=actor_role,
            action="candidate_merged",
            field_name="merge",
            old_value={"source_candidate_id": str(source_candidate.id)},
            new_value={"target_candidate_id": str(target_candidate.id), "reason": payload.merge_reason},
        )
        self.db.commit()
        return self._require_candidate(org_id=org_id, workspace_id=workspace_id, candidate_id=target_candidate.id)

    # -------------------------------
    # Bulk upload
    # -------------------------------
    def create_bulk_upload_job(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        actor_user_id: UUID | None,
        request: BulkUploadRequest,
    ) -> BulkUploadJob:
        job = BulkUploadJob(
            org_id=org_id,
            workspace_id=workspace_id,
            status=BulkUploadStatus.PENDING,
            requested_by=actor_user_id,
            total_items=len(request.files),
            processed_items=0,
            success_items=0,
            failed_items=0,
            skipped_items=0,
        )
        self.repository.create_bulk_upload_job(job)
        items = [
            BulkUploadItem(
                org_id=org_id,
                workspace_id=workspace_id,
                job_id=job.id,
                row_number=index + 1,
                resume_s3_key=file_key,
                original_file_name=file_key.split("/")[-1],
                status=BulkUploadItemStatus.PENDING,
            )
            for index, file_key in enumerate(request.files)
        ]
        self.repository.create_bulk_upload_items(items)
        self.db.commit()

        if self.task_enqueuer is not None:
            for item in items:
                self.task_enqueuer.enqueue_bulk_upload_item(
                    job_id=job.id,
                    item_id=item.id,
                    org_id=org_id,
                    workspace_id=workspace_id,
                )
        return self.repository.get_bulk_upload_job(org_id=org_id, workspace_id=workspace_id, job_id=job.id, with_items=True) or job

    def get_bulk_upload_job(self, *, org_id: UUID, workspace_id: UUID, job_id: UUID) -> BulkUploadJob:
        job = self.repository.get_bulk_upload_job(org_id=org_id, workspace_id=workspace_id, job_id=job_id, with_items=True)
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bulk upload job not found.")
        return job

    # -------------------------------
    # Helpers
    # -------------------------------
    def _mark_resume_parse_failed(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID | None,
        error: str,
    ) -> None:
        """Persist parse-failure state on the candidate row, if one exists.

        Best-effort: parsing can fail before a candidate row exists (e.g.
        first-time upload). We swallow DB errors here because the caller is
        about to surface the original parse exception to the client.
        """
        if candidate_id is None:
            return
        try:
            candidate = self.repository.get_candidate_by_id(
                org_id=org_id,
                workspace_id=workspace_id,
                candidate_id=candidate_id,
                include_deleted=True,
                with_skills=False,
            )
            if candidate is None:
                return
            self.repository.update_candidate_fields(
                candidate,
                {
                    "parse_status": CandidateParseStatus.FAILED,
                    "parse_error": error[:2000],
                    "parsed_at": datetime.now(timezone.utc),
                },
            )
            self.db.commit()
        except SQLAlchemyError:
            logger.exception("Failed to persist parse_status=failed for candidate %s", candidate_id)
            self.db.rollback()

    def _require_candidate(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID,
        with_skills: bool = True,
        include_archived: bool = False,
    ) -> Candidate:
        candidate = self.repository.get_candidate_by_id(
            org_id=org_id,
            workspace_id=workspace_id,
            candidate_id=candidate_id,
            include_deleted=include_archived,
            with_skills=with_skills,
        )
        if candidate is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Candidate not found.")
        return candidate

    def _build_skills(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID,
        skills: list[CandidateSkillInput],
    ) -> list[CandidateSkill]:
        built: list[CandidateSkill] = []
        dedupe: set[str] = set()
        for skill in skills:
            normalized_name = skill.name.strip().lower()
            if not normalized_name or normalized_name in dedupe:
                continue
            dedupe.add(normalized_name)
            built.append(
                CandidateSkill(
                    org_id=org_id,
                    workspace_id=workspace_id,
                    candidate_id=candidate_id,
                    name=skill.name.strip(),
                    normalized_name=normalized_name,
                    proficiency=skill.proficiency,
                    years_experience=skill.years_experience,
                    confidence=skill.confidence,
                    source=skill.source or "manual",
                )
            )
        return built

    def _insert_audit_log(
        self,
        *,
        org_id: UUID,
        workspace_id: UUID,
        candidate_id: UUID,
        actor_user_id: UUID | None,
        actor_role: str | None,
        action: str,
        field_name: str,
        old_value: dict[str, Any] | None,
        new_value: dict[str, Any] | None,
    ) -> None:
        try:
            with self.db.begin_nested():
                self.repository.create_audit_log(
                    CandidateAuditLog(
                        org_id=org_id,
                        workspace_id=workspace_id,
                        candidate_id=candidate_id,
                        action=action,
                        field_name=field_name,
                        old_value=old_value,
                        new_value=new_value,
                        actor_user_id=actor_user_id,
                        actor_role=actor_role,
                    )
                )
        except Exception as e:
            logger.error(f"Audit log insert failed for candidate {candidate_id}: {e}")

    def _apply_post_filters(
        self,
        candidates: list[Candidate],
        *,
        skills: list[str] | None,
        location: str | None,
        min_years_experience: int | None,
        max_years_experience: int | None,
        status: str | None = None,
        stage: str | None = None,
        source: str | None = None,
        job_id: UUID | None = None,
    ) -> list[Candidate]:
        normalized_skills = {value.strip().lower() for value in (skills or []) if value.strip()}
        location_query = location.strip().lower() if location else None
        filtered: list[Candidate] = []
        for candidate in candidates:
            if status is not None and candidate.status != status:
                continue
            if stage is not None and candidate.stage != stage:
                continue
            if source is not None and candidate.source != source:
                continue
            if job_id is not None and candidate.job_id != job_id:
                continue
            if normalized_skills:
                candidate_skills = {skill.normalized_name for skill in candidate.skills}
                if not normalized_skills.issubset(candidate_skills):
                    continue
            if location_query and (candidate.location is None or location_query not in candidate.location.lower()):
                continue
            if min_years_experience is not None and (
                candidate.years_experience is None or candidate.years_experience < min_years_experience
            ):
                continue
            if max_years_experience is not None and (
                candidate.years_experience is None or candidate.years_experience > max_years_experience
            ):
                continue
            filtered.append(candidate)
        return filtered

    @staticmethod
    def _optional_str(value: Any) -> str | None:
        if value is None:
            return None
        text = CandidateManagementService._sanitize_text(value).strip()
        return text or None

    @staticmethod
    def _optional_int(value: Any) -> int | None:
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _normalized_optional_email(value: Any) -> str | None:
        if value is None:
            return None
        text = str(value).strip().lower()
        if not text:
            return None
        # Ignore common parser placeholders so they don't trigger false duplicate checks.
        if text in {"na", "n/a", "none", "null", "nil", "-", "--", "not provided", "unknown"}:
            return None
        # Treat malformed values as absent rather than a dedupe key.
        if "@" not in text or text.startswith("@") or text.endswith("@"):
            return None
        return text

    @staticmethod
    def _normalize_candidate(candidate: Candidate) -> dict[str, Any]:
        from app.candidate_management.schemas import CandidateStageSchema, CandidateStatusSchema, CandidateSourceSchema
        from pydantic import EmailStr, TypeAdapter
        from sqlalchemy import inspect
        
        # Serialize ORM to dict safely
        try:
            data = {c.key: getattr(candidate, c.key) for c in inspect(candidate).mapper.column_attrs}
        except Exception:
            # Fallback if inspection fails
            data = {
                "id": candidate.id,
                "org_id": candidate.org_id,
                "workspace_id": candidate.workspace_id,
                "first_name": candidate.first_name,
                "last_name": candidate.last_name,
                "full_name": candidate.full_name,
                "email": candidate.email,
                "phone": candidate.phone,
                "location": candidate.location,
                "years_experience": candidate.years_experience,
                "headline": candidate.headline,
                "summary": candidate.summary,
                "stage": candidate.stage,
                "source": candidate.source,
                "status": candidate.status,
                "resume_s3_key": candidate.resume_s3_key,
                "resume_file_name": candidate.resume_file_name,
                "resume_uploaded_at": candidate.resume_uploaded_at,
                "ai_parse_version": candidate.ai_parse_version,
                "parse_confidence": candidate.parse_confidence,
                "parsed_resume_data": candidate.parsed_resume_data,
                "merged_into_candidate_id": candidate.merged_into_candidate_id,
                "merged_at": candidate.merged_at,
                "created_by": candidate.created_by,
                "updated_by": candidate.updated_by,
                "deleted_by": candidate.deleted_by,
                "created_at": candidate.created_at,
                "updated_at": candidate.updated_at,
                "deleted_at": candidate.deleted_at,
                "recruiter_id": candidate.recruiter_id,
            }
        
        # Handle email safely
        email = data.get("email")
        if email is not None:
            email_str = str(email).strip()
            if not email_str:
                data["email"] = None
            else:
                try:
                    TypeAdapter(EmailStr).validate_python(email_str)
                    data["email"] = email_str
                except Exception:
                    data["email"] = None
                
        # Handle enums safely
        stage = data.get("stage")
        valid_stages = {e.value for e in CandidateStageSchema}
        if stage is None or str(stage).strip().lower() not in valid_stages:
            data["stage"] = CandidateStageSchema.APPLIED.value
        else:
            data["stage"] = str(stage).strip().lower()

        status_val = data.get("status")
        valid_statuses = {e.value for e in CandidateStatusSchema}
        if status_val is None or str(status_val).strip().lower() not in valid_statuses:
            data["status"] = CandidateStatusSchema.ACTIVE.value
        else:
            data["status"] = str(status_val).strip().lower()

        source = data.get("source")
        valid_sources = {e.value for e in CandidateSourceSchema}
        if source is None or str(source).strip().lower() not in valid_sources:
            data["source"] = CandidateSourceSchema.MANUAL.value
        else:
            data["source"] = str(source).strip().lower()
                
        # Handle skills safely
        data["skills"] = []
        try:
            if "skills" not in inspect(candidate).unloaded:
                skills = []
                for skill in getattr(candidate, "skills", []):
                    try:
                        s_data = {c.key: getattr(skill, c.key) for c in inspect(skill).mapper.column_attrs}
                        skills.append(s_data)
                    except Exception:
                        continue
                data["skills"] = skills
        except Exception:
            pass

        return data

    @staticmethod
    def _coerce_interaction_metadata_for_api(value: Any) -> dict[str, Any] | None:
        if value is None:
            return None
        if isinstance(value, dict):
            return value
        return {"_legacy_wrapped": True, "value": value}

    @staticmethod
    def _normalize_interaction(interaction: CandidateInteraction) -> dict[str, Any]:
        from app.candidate_management.schemas import InteractionTypeSchema
        from sqlalchemy import inspect

        try:
            data = {c.key: getattr(interaction, c.key) for c in inspect(interaction).mapper.column_attrs}
        except Exception:
            data = {
                "id": interaction.id,
                "candidate_id": interaction.candidate_id,
                "org_id": interaction.org_id,
                "workspace_id": interaction.workspace_id,
                "interaction_type": interaction.interaction_type,
                "title": interaction.title,
                "body": interaction.body,
                "interaction_metadata": interaction.interaction_metadata,
                "actor_user_id": interaction.actor_user_id,
                "actor_role": interaction.actor_role,
                "created_at": interaction.created_at,
            }

        # Handle interaction_type enum safely
        it = data.get("interaction_type")
        valid_types = {e.value for e in InteractionTypeSchema}
        if it is None or str(it).strip().lower() not in valid_types:
            data["interaction_type"] = InteractionTypeSchema.SYSTEM.value
        else:
            data["interaction_type"] = str(it).strip().lower()

        raw_meta = data.pop("interaction_metadata", None)
        if raw_meta is None:
            raw_meta = data.pop("metadata", None)
        data["metadata"] = CandidateManagementService._coerce_interaction_metadata_for_api(raw_meta)
        return data
    @staticmethod
    def _normalized_optional_phone(value: Any) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        if not text:
            return None
        lowered = text.lower()
        if lowered in {"na", "n/a", "none", "null", "nil", "-", "--", "not provided", "unknown"}:
            return None
        # Normalize to digits (and optional leading +) to avoid duplicate conflicts on formatting noise.
        normalized = re.sub(r"[^\d+]", "", text)
        if normalized.startswith("++"):
            normalized = normalized.lstrip("+")
        # Very short numbers are usually placeholders/noise.
        digit_count = len(re.sub(r"\D", "", normalized))
        if digit_count < 7:
            return None
        return normalized

    @staticmethod
    def _json_safe(value: Any) -> Any:
        if isinstance(value, UUID):
            return str(value)
        if isinstance(value, datetime):
            return value.isoformat()
        return value

    @staticmethod
    def _sanitize_text(value: Any) -> str:
        # PostgreSQL text/json fields reject NUL bytes; strip them defensively.
        return str(value).replace("\x00", "")

    @staticmethod
    def _sanitize_json_value(value: Any) -> Any:
        if isinstance(value, str):
            return CandidateManagementService._sanitize_text(value)
        if isinstance(value, list):
            return [CandidateManagementService._sanitize_json_value(item) for item in value]
        if isinstance(value, dict):
            return {
                CandidateManagementService._sanitize_text(key): CandidateManagementService._sanitize_json_value(val)
                for key, val in value.items()
            }
        return value

    def _sync_candidate_pipeline(self, *, candidate: Candidate, actor_user_id: UUID | None) -> None:
        if candidate.job_id is None:
            return
        logger.info(
            "Syncing candidate submission",
            extra={
                "candidate_id": str(candidate.id),
                "job_id": str(candidate.job_id),
                "org_id": str(candidate.org_id),
            },
        )
        job_exists = self.db.scalar(
            select(Job.id).where(
                Job.organization_id == candidate.org_id,
                Job.id == candidate.job_id,
            )
        )
        if job_exists is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Selected job does not exist for this organization.",
            )

        # Candidate-job mapping should not block pipeline creation if mapping table is unavailable.
        try:
            with self.db.begin_nested():
                application = self.db.scalar(
                    select(Application).where(
                        Application.organization_id == candidate.org_id,
                        Application.candidate_id == candidate.id,
                        Application.job_id == candidate.job_id,
                    )
                )
                if application is None:
                    self.db.add(
                        Application(
                            organization_id=candidate.org_id,
                            candidate_id=candidate.id,
                            job_id=candidate.job_id,
                            stage="applied",
                            status="active",
                            notes=f"Created via candidate management sync by {actor_user_id}" if actor_user_id else None,
                        )
                    )
                    self.db.flush()
        except SQLAlchemyError as exc:
            logger.exception(
                "Application mapping sync failed",
                extra={
                    "candidate_id": str(candidate.id),
                    "job_id": str(candidate.job_id),
                    "stage": str(candidate.stage),
                    "db_error": str(exc),
                },
            )

        mapped_stage = self._candidate_stage_to_pipeline_stage(candidate.stage)
        try:
            with self.db.begin_nested():
                pipeline = self.db.scalar(
                    select(Pipeline).where(
                        Pipeline.organization_id == candidate.org_id,
                        Pipeline.candidate_id == candidate.id,
                        Pipeline.job_id == candidate.job_id,
                    )
                )
                if pipeline is None:
                    logger.info(
                        "Creating new pipeline entry",
                        extra={"candidate_id": str(candidate.id), "job_id": str(candidate.job_id), "stage": mapped_stage},
                    )
                    self.db.add(
                        Pipeline(
                            organization_id=candidate.org_id,
                            candidate_id=candidate.id,
                            job_id=candidate.job_id,
                            stage=mapped_stage,
                            status="active",
                            notes=f"Created via candidate management sync by {actor_user_id}" if actor_user_id else None,
                        )
                    )
                    self.db.flush()
                else:
                    logger.info(
                        "Updating existing pipeline stage",
                        extra={"candidate_id": str(candidate.id), "job_id": str(candidate.job_id), "stage": mapped_stage},
                    )
                    pipeline.stage = mapped_stage
                    self.db.add(pipeline)
                    self.db.flush()
        except IntegrityError as exc:
            logger.exception(
                "Pipeline duplicate conflict during sync",
                extra={
                    "candidate_id": str(candidate.id),
                    "job_id": str(candidate.job_id),
                    "stage": mapped_stage,
                    "db_error": str(exc),
                },
            )
            # If concurrent insert happened, update existing row instead of failing.
            existing = self.db.scalar(
                select(Pipeline).where(
                    Pipeline.organization_id == candidate.org_id,
                    Pipeline.candidate_id == candidate.id,
                    Pipeline.job_id == candidate.job_id,
                )
            )
            if existing is not None:
                existing.stage = mapped_stage
                self.db.add(existing)
                self.db.flush()
                return
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Duplicate pipeline entry detected for candidate and job.",
            ) from None
        except SQLAlchemyError as exc:
            logger.exception(
                "Pipeline sync failed",
                extra={
                    "candidate_id": str(candidate.id),
                    "job_id": str(candidate.job_id),
                    "stage": mapped_stage,
                    "db_error": str(exc),
                },
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Pipeline sync failed for this candidate submission.",
            ) from None

    @staticmethod
    def _candidate_stage_to_pipeline_stage(candidate_stage: str) -> str:
        stage_map = {
            "applied": "applied",
            "screening": "screening",
            "shortlisted": "screening",
            "interview": "interview",
            "offered": "offer",
            "hired": "placed",
            "rejected": "rejected",
        }
        return stage_map.get(candidate_stage, "applied")

