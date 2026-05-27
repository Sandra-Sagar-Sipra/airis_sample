from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.analytics.schemas import (
    OpenJobsResponse, 
    PipelineOverviewResponse,
    RecruiterActivityResponse,
    TimeToShortlistResponse,
    PlacementTrackingResponse,
    DashboardSummaryResponse
)
from app.analytics.service import AnalyticsService
from app.core.dependencies import get_current_user, require_any_permissions
from app.core.permissions import JOBS_READ
from app.db.session import get_db
from app.schemas.auth import CurrentUser

router = APIRouter(prefix="/analytics", tags=["analytics"])

@router.get(
    "/open-jobs",
    response_model=OpenJobsResponse,
    summary="Analytics: Open Jobs metrics dashboard",
)
def get_open_jobs_analytics(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(JOBS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> OpenJobsResponse:
    """
    GET /api/v1/analytics/open-jobs
    Returns open job metrics, jobs by status, jobs by client, and recently created jobs.
    """
    org_id = UUID(current_user.organization_id)
    service = AnalyticsService(db)
    return service.get_open_jobs(org_id, current_user)

@router.get(
    "/pipeline",
    response_model=PipelineOverviewResponse,
    summary="Analytics: Pipeline candidates dashboard",
)
def get_pipeline_analytics(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(JOBS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> PipelineOverviewResponse:
    """
    GET /api/v1/analytics/pipeline
    Returns total candidates in active pipelines, candidates by stage, and by source.
    """
    org_id = UUID(current_user.organization_id)
    service = AnalyticsService(db)
    return service.get_pipeline_analytics(org_id, current_user)

@router.get(
    "/recruiter-activity",
    response_model=RecruiterActivityResponse,
    summary="Analytics: Recruiter activity metrics",
)
def get_recruiter_activity(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(JOBS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> RecruiterActivityResponse:
    """
    GET /api/v1/analytics/recruiter-activity
    Returns total submissions, interviews, placements, and breakdown by recruiter.
    """
    org_id = UUID(current_user.organization_id)
    service = AnalyticsService(db)
    return service.get_recruiter_activity(org_id, current_user)

@router.get(
    "/time-to-shortlist",
    response_model=TimeToShortlistResponse,
    summary="Analytics: Time-to-shortlist metrics",
)
def get_time_to_shortlist(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(JOBS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> TimeToShortlistResponse:
    """
    GET /api/v1/analytics/time-to-shortlist
    Returns average, fastest, and slowest times from pipeline creation to screening.
    """
    org_id = UUID(current_user.organization_id)
    service = AnalyticsService(db)
    return service.get_time_to_shortlist(org_id, current_user)

@router.get(
    "/placement-tracking",
    response_model=PlacementTrackingResponse,
    summary="Analytics: Placement tracking dashboard",
)
def get_placement_tracking(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(JOBS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> PlacementTrackingResponse:
    """
    GET /api/v1/analytics/placement-tracking
    Returns total placements and trends by recruiter and client.
    """
    org_id = UUID(current_user.organization_id)
    service = AnalyticsService(db)
    return service.get_placement_tracking(org_id, current_user)

@router.get(
    "/dashboard-summary",
    response_model=DashboardSummaryResponse,
    summary="Analytics: Unified dashboard summary",
)
def get_dashboard_summary(
    db: Annotated[Session, Depends(get_db)],
    _: Annotated[CurrentUser, Depends(require_any_permissions(JOBS_READ))],
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> DashboardSummaryResponse:
    """
    GET /api/v1/analytics/dashboard-summary
    Returns a cached overview of all dashboard metrics.
    """
    org_id = UUID(current_user.organization_id)
    service = AnalyticsService(db)
    return service.get_dashboard_summary(org_id, current_user)
