from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime
from uuid import UUID

class JobStatusCount(BaseModel):
    status: str
    count: int

class ClientJobCount(BaseModel):
    client_name: Optional[str]
    count: int

class RecentJobItem(BaseModel):
    id: UUID
    title: str
    client_name: Optional[str]
    status: str
    created_at: datetime

class OpenJobsResponse(BaseModel):
    total_active: int
    by_status: List[JobStatusCount]
    by_client: List[ClientJobCount]
    recent_jobs: List[RecentJobItem]


class StageCount(BaseModel):
    stage: str
    count: int

class SourceCount(BaseModel):
    source: Optional[str]
    count: int

class PipelineOverviewResponse(BaseModel):
    total_candidates: int
    by_stage: List[StageCount]
    by_source: List[SourceCount]


class RecruiterStats(BaseModel):
    recruiter_name: Optional[str]
    submissions: int
    interviews: int
    placements: int

class RecruiterActivityResponse(BaseModel):
    total_submissions: int
    total_interviews: int
    total_placements: int
    by_recruiter: List[RecruiterStats]


class TimeToShortlistResponse(BaseModel):
    average_days: float
    fastest_days: float
    slowest_days: float


class PlacementCount(BaseModel):
    name: Optional[str]
    count: int

class PlacementTrackingResponse(BaseModel):
    total_placements: int
    by_client: List[PlacementCount]
    by_recruiter: List[PlacementCount]


class DashboardSummaryResponse(BaseModel):
    open_jobs: OpenJobsResponse
    pipeline: PipelineOverviewResponse
    recruiter_activity: RecruiterActivityResponse
    time_to_shortlist: TimeToShortlistResponse
    placement_tracking: PlacementTrackingResponse

