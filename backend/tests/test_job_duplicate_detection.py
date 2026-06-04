from __future__ import annotations

import pytest
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import status

from app.models.job import Job
from app.schemas.job_dedup import DuplicateJobCheckRequest


@pytest.fixture
def other_org_id():
    return uuid4()


@pytest.fixture
def setup_test_jobs(db_session, test_organization, other_org_id):
    job1 = Job(
        id=uuid4(),
        organization_id=test_organization.id,
        title="Software Engineer",
        status="open",
        location="New York",
        client_id=uuid4(),
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    job2 = Job(
        id=uuid4(),
        organization_id=test_organization.id,
        title="Software Engineer",
        status="closed",
        location="San Francisco",
        client_id=uuid4(),
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    job_other_org = Job(
        id=uuid4(),
        organization_id=other_org_id,
        title="Software Engineer",
        status="open",
        location="New York",
        client_id=uuid4(),
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db_session.add_all([job1, job2, job_other_org])
    db_session.commit()
    return {"job1": job1, "job2": job2, "job_other_org": job_other_org}


def test_job_duplicate_detection_no_duplicates(client, test_organization_headers, db_session):
    payload = {"title": "Data Scientist"}
    response = client.post(
        "/api/v1/jobs/check-duplicate",
        headers=test_organization_headers,
        json=payload,
    )
    assert response.status_code == status.HTTP_200_OK
    data = response.json()
    assert data["has_duplicates"] is False
    assert len(data["matches"]) == 0


def test_job_duplicate_detection_match_title_only(client, test_organization_headers, db_session, setup_test_jobs):
    payload = {"title": "software engineer"}
    response = client.post(
        "/api/v1/jobs/check-duplicate",
        headers=test_organization_headers,
        json=payload,
    )
    assert response.status_code == status.HTTP_200_OK
    data = response.json()
    assert data["has_duplicates"] is True
    # Should match both job1 and job2 with 0.9 confidence since location wasn't provided
    assert len(data["matches"]) == 2
    for match in data["matches"]:
        assert match["confidence"] == 0.9
        assert match["title"] == "Software Engineer"


def test_job_duplicate_detection_match_title_and_location(client, test_organization_headers, db_session, setup_test_jobs):
    payload = {"title": "software engineer", "location": "new york"}
    response = client.post(
        "/api/v1/jobs/check-duplicate",
        headers=test_organization_headers,
        json=payload,
    )
    assert response.status_code == status.HTTP_200_OK
    data = response.json()
    assert data["has_duplicates"] is True
    assert len(data["matches"]) == 2
    
    # job1 has "New York" -> confidence 1.0
    # job2 has "San Francisco" -> confidence 0.9
    confidences = {m["confidence"] for m in data["matches"]}
    assert confidences == {0.9, 1.0}


def test_job_duplicate_detection_cross_tenant_isolation(client, db_session, setup_test_jobs, get_test_token, other_org_id):
    # Call with a token for the other organization
    other_org_headers = {"Authorization": f"Bearer {get_test_token(org_id=str(other_org_id))}"}
    payload = {"title": "software engineer"}
    response = client.post(
        "/api/v1/jobs/check-duplicate",
        headers=other_org_headers,
        json=payload,
    )
    assert response.status_code == status.HTTP_200_OK
    data = response.json()
    assert data["has_duplicates"] is True
    assert len(data["matches"]) == 1  # Only job_other_org should be visible
    assert data["matches"][0]["job_id"] == str(setup_test_jobs["job_other_org"].id)


def test_job_duplicate_detection_exclude_id(client, test_organization_headers, db_session, setup_test_jobs):
    job1_id = str(setup_test_jobs["job1"].id)
    payload = {"title": "software engineer", "exclude_id": job1_id}
    response = client.post(
        "/api/v1/jobs/check-duplicate",
        headers=test_organization_headers,
        json=payload,
    )
    assert response.status_code == status.HTTP_200_OK
    data = response.json()
    assert data["has_duplicates"] is True
    assert len(data["matches"]) == 1
    # Only job2 should remain
    assert data["matches"][0]["job_id"] == str(setup_test_jobs["job2"].id)

