"""Job Duplicate detection service.

Checks for existing jobs that may be duplicates of a prospective new job.
Always org-scoped.

Detection priority:
  1. Title (case-insensitive) + Location (case-insensitive) exact match → confidence 1.0
  2. Title (case-insensitive) exact match → confidence 0.9
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.job import Job

logger = logging.getLogger(__name__)


@dataclass
class DuplicateJobMatch:
    """A single job that is a probable duplicate."""

    job_id: str
    title: str
    status: str
    created_at: datetime
    client_id: str | None
    location: str | None
    confidence: float  # 0.0 – 1.0


@dataclass
class DuplicateJobCheckResult:
    """Result of a duplicate check."""

    has_duplicates: bool
    matches: list[DuplicateJobMatch] = field(default_factory=list)


class DuplicateJobDetectionService:
    """Check for duplicate jobs within an organisation."""

    def check(
        self,
        *,
        title: str,
        client_id: UUID | None,
        location: str | None,
        org_id: UUID,
        db: Session,
        exclude_id: UUID | None = None,
    ) -> DuplicateJobCheckResult:
        """Return duplicate matches for the given job details."""
        matches: list[DuplicateJobMatch] = []
        seen_ids: set[UUID] = set()

        norm_title = title.strip().lower() if title else ""
        norm_location = location.strip().lower() if location and location.strip() else None

        if not norm_title:
            return DuplicateJobCheckResult(has_duplicates=False, matches=[])

        jobs = self._query_jobs(db, org_id, client_id, exclude_id)
        
        for job in jobs:
            job_title = job.title.strip().lower() if job.title else ""
            if job_title == norm_title:
                job_location = job.location.strip().lower() if job.location and job.location.strip() else None
                
                # If a location is provided in the request, we can check for a 1.0 match
                if norm_location and job_location == norm_location:
                    seen_ids.add(job.id)
                    matches.append(self._build_match(job, confidence=1.0))
                else:
                    if job.id not in seen_ids:
                        seen_ids.add(job.id)
                        matches.append(self._build_match(job, confidence=0.9))

        # Sort by confidence descending
        matches.sort(key=lambda m: m.confidence, reverse=True)

        logger.debug(
            "job.dedup.check",
            extra={
                "org_id": str(org_id),
                "title_provided": bool(norm_title),
                "location_provided": bool(norm_location),
                "matches_found": len(matches),
            },
        )

        return DuplicateJobCheckResult(has_duplicates=bool(matches), matches=matches)

    def _query_jobs(
        self, db: Session, org_id: UUID, client_id: UUID | None, exclude_id: UUID | None
    ) -> list[Job]:
        stmt = (
            select(Job)
            .where(
                Job.organization_id == org_id,
            )
        )
        if client_id is not None:
            stmt = stmt.where(Job.client_id == client_id)
        if exclude_id is not None:
            stmt = stmt.where(Job.id != exclude_id)
        return list(db.scalars(stmt))

    def _build_match(
        self,
        job: Job,
        confidence: float,
    ) -> DuplicateJobMatch:
        return DuplicateJobMatch(
            job_id=str(job.id),
            title=job.title,
            status=job.status,
            created_at=job.created_at,
            client_id=str(job.client_id) if job.client_id else None,
            location=job.location,
            confidence=confidence,
        )
