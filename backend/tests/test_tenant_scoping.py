from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException

from app.core.permissions import ALL_PERMISSIONS
from app.schemas.pipeline import PipelineCreate
from app.services.candidate_service import CandidateService
from app.services.pipeline_service import PipelineService
from app.services.permission_service import PermissionService
from app.schemas.auth import CurrentUser

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    ("path", "service_class", "method_name"),
    [
        ("/api/v1/candidates", "app.services.candidate_service.CandidateService", "list_candidates"),
        ("/api/v1/clients", "app.services.client_service.ClientService", "list_clients"),
        ("/api/v1/jobs", "app.services.job_service.JobService", "list_jobs"),
        # The GET /api/v1/pipelines route delegates to list_pipelines_paginated
        # (introduced in PIPE-004) which returns (items, total, stage_counts).
        ("/api/v1/pipelines", "app.services.pipeline_service.PipelineService", "list_pipelines_paginated"),
        ("/api/v1/interviews", "app.services.interview_service.InterviewService", "list_interviews"),
    ],
)
def test_list_endpoints_are_scoped_by_organization_id(
    client,
    auth_headers,
    force_auth,
    monkeypatch,
    path,
    service_class,
    method_name,
):
    captured: dict[str, UUID] = {}

    def _capture_org(self, organization_id, *args, **kwargs):
        captured["organization_id"] = organization_id
        # list_pipelines_paginated returns (items, total, stage_counts);
        # all other list_* methods return a plain list.
        if method_name == "list_pipelines_paginated":
            return [], 0, {}
        return []

    module_name, class_name = service_class.rsplit(".", maxsplit=1)
    module = __import__(module_name, fromlist=[class_name])
    klass = getattr(module, class_name)
    monkeypatch.setattr(klass, method_name, _capture_org)
    # Patch both permission paths: can_user (old) and get_user_permissions (new,
    # used by _effective_permissions_for_request in require_permission).
    monkeypatch.setattr(PermissionService, "can_user", lambda *args, **kwargs: True)
    monkeypatch.setattr(
        PermissionService,
        "get_user_permissions",
        lambda *args, **kwargs: list(ALL_PERMISSIONS),
    )

    response = client.get(path)
    assert response.status_code == 200
    assert captured["organization_id"] == UUID(auth_headers["X-Organization-Id"])


class _PipelineCreateDbStub:
    def __init__(self):
        self._scalar_calls = 0

    def scalar(self, *_args, **_kwargs):
        self._scalar_calls += 1
        if self._scalar_calls == 1:
            return object()  # job exists
        return None  # no existing pipeline duplicate

    def add(self, *_args, **_kwargs):
        return None

    def commit(self):
        return None

    def flush(self):
        return None

    def refresh(self, *_args, **_kwargs):
        return None


def test_pipeline_create_validates_foreign_keys_within_same_org(monkeypatch):
    db = _PipelineCreateDbStub()
    service = PipelineService(db)
    expected_org = uuid4()
    candidate_id = uuid4()
    job_id = uuid4()

    seen: dict[str, UUID] = {}

    def _candidate_check(self, candidate_id_arg, organization_id_arg, current_user):
        seen["candidate_org"] = organization_id_arg
        seen["candidate_id"] = candidate_id_arg
        return object()

    monkeypatch.setattr(CandidateService, "get_candidate_by_id", _candidate_check)

    current_user = CurrentUser(
        user_id=str(uuid4()),
        organization_id=str(expected_org),
        role="admin",
    )
    service.create_pipeline(
        expected_org,
        current_user,
        PipelineCreate(candidate_id=candidate_id, job_id=job_id, stage="applied", status="active"),
    )

    assert seen["candidate_org"] == expected_org
    assert seen["candidate_id"] == candidate_id


class _PipelineLookupDbStub:
    def __init__(self, owner_org_id):
        self._calls = 0
        self._owner_org_id = owner_org_id

    def scalar(self, *_args, **_kwargs):
        self._calls += 1
        if self._calls == 1:
            return None
        return self._owner_org_id


def test_cross_tenant_pipeline_lookup_does_not_leak_owner_id():
    service = PipelineService(_PipelineLookupDbStub(owner_org_id=uuid4()))

    with pytest.raises(HTTPException) as exc:
        service.get_pipeline_by_id(uuid4(), uuid4())

    assert exc.value.status_code == 404
    assert exc.value.detail == "Pipeline not found."
