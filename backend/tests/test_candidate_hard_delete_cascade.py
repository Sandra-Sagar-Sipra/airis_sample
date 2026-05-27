"""Hard delete must purge pipeline + ATS match rows for fresh re-create."""
from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import select

from app.candidate_management.models import Candidate as CmCandidate
from app.models.candidate_job_match import CandidateJobMatch
from app.models.pipeline import Pipeline

pytestmark = pytest.mark.integration


def _workspace_headers(auth_headers: dict[str, str]) -> dict[str, str]:
    org_id = auth_headers["X-Organization-Id"]
    return {**auth_headers, "X-Workspace-Id": org_id}


@pytest.mark.integration
def test_hard_delete_removes_pipeline_and_match_rows(client, auth_headers, db_session):
    """After DELETE, same email can be re-added without old pipeline/ATS ghost data."""
    seed = uuid4().hex[:8]
    headers = _workspace_headers(auth_headers)
    email = f"cascade.del.{seed}@example.com"

    create = client.post(
        "/api/v1/candidate-management/candidates",
        headers=headers,
        json={"first_name": "Aravind", "last_name": f"Kumar{seed}", "email": email},
    )
    assert create.status_code == 201, create.text
    candidate_id = UUID(create.json()["data"]["id"])

    jobs = client.get("/api/v1/jobs", headers=auth_headers, params={"limit": 1})
    assert jobs.status_code == 200
    job_list = jobs.json()
    items = job_list if isinstance(job_list, list) else job_list.get("data") or job_list.get("items") or []
    if not items:
        pytest.skip("No jobs in test DB")
    job_id = items[0]["id"] if isinstance(items[0], dict) else items[0].id

    submit = client.post(
        f"/api/v1/jobs/{job_id}/submissions",
        headers=auth_headers,
        json={"candidate_id": str(candidate_id), "notes": "test"},
    )
    if submit.status_code not in (200, 201):
        pytest.skip(f"Job submit not available: {submit.status_code} {submit.text}")

    pipeline = db_session.scalar(
        select(Pipeline).where(Pipeline.candidate_id == candidate_id, Pipeline.job_id == UUID(job_id))
    )
    assert pipeline is not None

    delete = client.delete(
        f"/api/v1/candidate-management/candidates/{candidate_id}",
        headers=headers,
    )
    assert delete.status_code == 200, delete.text

    assert db_session.get(CmCandidate, candidate_id) is None
    assert (
        db_session.scalar(
            select(Pipeline).where(Pipeline.candidate_id == candidate_id, Pipeline.job_id == UUID(job_id))
        )
        is None
    )
    assert (
        db_session.scalar(
            select(CandidateJobMatch).where(
                CandidateJobMatch.candidate_id == candidate_id,
                CandidateJobMatch.job_id == UUID(job_id),
            )
        )
        is None
    )

    recreate = client.post(
        "/api/v1/candidate-management/candidates",
        headers=headers,
        json={"first_name": "Aravind", "last_name": f"Kumar{seed}", "email": email},
    )
    assert recreate.status_code == 201, recreate.text
    new_id = recreate.json()["data"]["id"]
    assert new_id != str(candidate_id)
