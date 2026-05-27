from uuid import UUID
from sqlalchemy.orm import Session
from app.schemas.auth import CurrentUser
from app.analytics.repository import AnalyticsRepository

from cachetools import TTLCache

# Cache dashboard summary for 60 seconds to prevent DB overload
dashboard_cache = TTLCache(maxsize=100, ttl=60)
pipeline_cache = TTLCache(maxsize=100, ttl=60)
recruiter_cache = TTLCache(maxsize=100, ttl=60)

class AnalyticsService:
    def __init__(self, db: Session):
        self.db = db
        self.repository = AnalyticsRepository(db)

    def get_open_jobs(self, org_id: UUID, current_user: CurrentUser):
        return self.repository.get_open_jobs_metrics(org_id, current_user)

    def get_pipeline_analytics(self, org_id: UUID, current_user: CurrentUser):
        cache_key = f"{org_id}_{current_user.user_id}"
        if cache_key in pipeline_cache:
            return pipeline_cache[cache_key]
        res = self.repository.get_pipeline_metrics(org_id, current_user)
        pipeline_cache[cache_key] = res
        return res

    def get_recruiter_activity(self, org_id: UUID, current_user: CurrentUser):
        cache_key = f"{org_id}_{current_user.user_id}"
        if cache_key in recruiter_cache:
            return recruiter_cache[cache_key]
        res = self.repository.get_recruiter_activity(org_id, current_user)
        recruiter_cache[cache_key] = res
        return res

    def get_time_to_shortlist(self, org_id: UUID, current_user: CurrentUser):
        return self.repository.get_time_to_shortlist(org_id, current_user)

    def get_placement_tracking(self, org_id: UUID, current_user: CurrentUser):
        return self.repository.get_placement_tracking(org_id, current_user)

    def get_dashboard_summary(self, org_id: UUID, current_user: CurrentUser):
        cache_key = f"{org_id}_{current_user.user_id}"
        if cache_key in dashboard_cache:
            return dashboard_cache[cache_key]

        summary = {
            "open_jobs": self.repository.get_open_jobs_metrics(org_id, current_user),
            "pipeline": self.repository.get_pipeline_metrics(org_id, current_user),
            "recruiter_activity": self.repository.get_recruiter_activity(org_id, current_user),
            "time_to_shortlist": self.repository.get_time_to_shortlist(org_id, current_user),
            "placement_tracking": self.repository.get_placement_tracking(org_id, current_user),
        }
        
        dashboard_cache[cache_key] = summary
        return summary

