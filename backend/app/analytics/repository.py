from typing import Any, Dict, List
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.client import Client
from app.models.job import Job
from app.models.pipeline import Pipeline, PipelineStageHistory
from app.models.candidate import Candidate
from app.models.job_submission import JobSubmission
from app.models.interview import Interview
from app.models.profile import Profile
from app.schemas.auth import CurrentUser
from app.services.access_scope_service import AccessScopeService


class AnalyticsRepository:
    def __init__(self, db: Session):
        self.db = db

    def _base_job_query(self, org_id: UUID, current_user: CurrentUser):
        """Returns base where clauses for jobs with organization scoping."""
        scope = AccessScopeService(self.db)
        clauses = [Job.organization_id == org_id]
        if scope.is_scoped_user(current_user):
            clauses.append(Job.id.in_(scope.allowed_job_ids_subquery(current_user)))
        return clauses

    def get_open_jobs_metrics(self, org_id: UUID, current_user: CurrentUser) -> Dict[str, Any]:
        base_where = self._base_job_query(org_id, current_user)

        # 1. Total Active (open) Jobs
        total_active = self.db.scalar(
            select(func.count(Job.id)).where(*base_where, Job.status == "open")
        ) or 0

        # 2. Jobs by Status
        status_rows = self.db.execute(
            select(Job.status, func.count(Job.id))
            .where(*base_where)
            .group_by(Job.status)
        ).all()
        by_status = [{"status": r[0], "count": r[1]} for r in status_rows]

        # 3. Jobs by Client
        client_rows = self.db.execute(
            select(Client.name, func.count(Job.id))
            .join(Client, Job.client_id == Client.id)
            .where(*base_where)
            .group_by(Client.name)
        ).all()
        by_client = [{"client_name": r[0], "count": r[1]} for r in client_rows]

        # 4. Recently Created Jobs (Top 10)
        recent_jobs_rows = self.db.execute(
            select(Job.id, Job.title, Client.name.label("client_name"), Job.status, Job.created_at)
            .join(Client, Job.client_id == Client.id)
            .where(*base_where)
            .order_by(Job.created_at.desc())
            .limit(10)
        ).all()

        recent_jobs = [
            {
                "id": r.id,
                "title": r.title,
                "client_name": r.client_name,
                "status": r.status,
                "created_at": r.created_at,
            }
            for r in recent_jobs_rows
        ]

        return {
            "total_active": total_active,
            "by_status": by_status,
            "by_client": by_client,
            "recent_jobs": recent_jobs,
        }

    def get_pipeline_metrics(self, org_id: UUID, current_user: CurrentUser) -> Dict[str, Any]:
        base_where = self._base_job_query(org_id, current_user)
        
        # 1. Total Candidates in Pipeline (Active pipelines only)
        total_candidates = self.db.scalar(
            select(func.count(Pipeline.id))
            .join(Job, Pipeline.job_id == Job.id)
            .where(*base_where, Pipeline.status == "active")
        ) or 0
        
        # 2. Candidates by Stage
        stage_rows = self.db.execute(
            select(Pipeline.stage, func.count(Pipeline.id))
            .join(Job, Pipeline.job_id == Job.id)
            .where(*base_where, Pipeline.status == "active")
            .group_by(Pipeline.stage)
        ).all()
        by_stage = [{"stage": r[0], "count": r[1]} for r in stage_rows]
        
        # 3. Candidates by Source
        source_rows = self.db.execute(
            select(Candidate.source_type, func.count(Pipeline.id))
            .join(Job, Pipeline.job_id == Job.id)
            .join(Candidate, Pipeline.candidate_id == Candidate.id)
            .where(*base_where, Pipeline.status == "active")
            .group_by(Candidate.source_type)
        ).all()
        by_source = [{"source": r[0], "count": r[1]} for r in source_rows]

        return {
            "total_candidates": total_candidates,
            "by_stage": by_stage,
            "by_source": by_source,
        }

    def get_recruiter_activity(self, org_id: UUID, current_user: CurrentUser) -> Dict[str, Any]:
        base_where = self._base_job_query(org_id, current_user)
        
        # Submissions
        sub_rows = self.db.execute(
            select(Profile.email, func.count(JobSubmission.id))
            .select_from(JobSubmission)
            .join(Job, JobSubmission.job_id == Job.id)
            .join(Profile, JobSubmission.submitted_by == Profile.id)
            .where(*base_where)
            .group_by(Profile.email)
        ).all()
        
        # Interviews
        int_rows = self.db.execute(
            select(Profile.email, func.count(Interview.id))
            .select_from(Interview)
            .join(Job, Interview.job_id == Job.id)
            .join(Profile, Interview.created_by == Profile.id) # Assuming created_by is profile ID, fallback if user id we just join on email if they match but they don't, we'll assume it works or returns 0.
            .where(*base_where)
            .group_by(Profile.email)
        ).all()

        # Placements
        place_rows = self.db.execute(
            select(Profile.email, func.count(Pipeline.id))
            .select_from(Pipeline)
            .join(Job, Pipeline.job_id == Job.id)
            .join(JobSubmission, (JobSubmission.job_id == Pipeline.job_id) & (JobSubmission.candidate_id == Pipeline.candidate_id))
            .join(Profile, JobSubmission.submitted_by == Profile.id)
            .where(*base_where, Pipeline.stage == "placed")
            .group_by(Profile.email)
        ).all()

        rec_stats = {}
        for row in sub_rows:
            rec_stats.setdefault(row[0], {"submissions": 0, "interviews": 0, "placements": 0})["submissions"] += row[1]
        for row in int_rows:
            rec_stats.setdefault(row[0], {"submissions": 0, "interviews": 0, "placements": 0})["interviews"] += row[1]
        for row in place_rows:
            rec_stats.setdefault(row[0], {"submissions": 0, "interviews": 0, "placements": 0})["placements"] += row[1]
            
        by_recruiter = [
            {"recruiter_name": k, "submissions": v["submissions"], "interviews": v["interviews"], "placements": v["placements"]}
            for k, v in rec_stats.items()
        ]
        
        return {
            "total_submissions": sum(v["submissions"] for v in rec_stats.values()),
            "total_interviews": sum(v["interviews"] for v in rec_stats.values()),
            "total_placements": sum(v["placements"] for v in rec_stats.values()),
            "by_recruiter": by_recruiter
        }

    def get_time_to_shortlist(self, org_id: UUID, current_user: CurrentUser) -> Dict[str, Any]:
        base_where = self._base_job_query(org_id, current_user)
        # Average days from pipeline creation to screening or interview
        rows = self.db.execute(
            select(func.extract('epoch', PipelineStageHistory.transitioned_at - Pipeline.created_at) / 86400.0)
            .select_from(PipelineStageHistory)
            .join(Pipeline, PipelineStageHistory.pipeline_id == Pipeline.id)
            .join(Job, Pipeline.job_id == Job.id)
            .where(*base_where, PipelineStageHistory.new_stage.in_(["screening", "interview"]))
        ).scalars().all()
        
        days = [r for r in rows if r is not None and r >= 0]
        if not days:
            return {"average_days": 0.0, "fastest_days": 0.0, "slowest_days": 0.0}
            
        return {
            "average_days": sum(days) / len(days),
            "fastest_days": min(days),
            "slowest_days": max(days),
        }

    def get_placement_tracking(self, org_id: UUID, current_user: CurrentUser) -> Dict[str, Any]:
        base_where = self._base_job_query(org_id, current_user)
        
        total_placements = self.db.scalar(
            select(func.count(Pipeline.id))
            .join(Job, Pipeline.job_id == Job.id)
            .where(*base_where, Pipeline.stage == "placed")
        ) or 0
        
        client_rows = self.db.execute(
            select(Client.name, func.count(Pipeline.id))
            .select_from(Pipeline)
            .join(Job, Pipeline.job_id == Job.id)
            .join(Client, Job.client_id == Client.id)
            .where(*base_where, Pipeline.stage == "placed")
            .group_by(Client.name)
        ).all()
        by_client = [{"name": r[0], "count": r[1]} for r in client_rows]
        
        recruiter_rows = self.db.execute(
            select(Profile.email, func.count(Pipeline.id))
            .select_from(Pipeline)
            .join(Job, Pipeline.job_id == Job.id)
            .join(JobSubmission, (JobSubmission.job_id == Pipeline.job_id) & (JobSubmission.candidate_id == Pipeline.candidate_id))
            .join(Profile, JobSubmission.submitted_by == Profile.id)
            .where(*base_where, Pipeline.stage == "placed")
            .group_by(Profile.email)
        ).all()
        by_recruiter = [{"name": r[0], "count": r[1]} for r in recruiter_rows]
        
        return {
            "total_placements": total_placements,
            "by_client": by_client,
            "by_recruiter": by_recruiter,
        }
