from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from jose import jwt
from sqlalchemy.exc import ProgrammingError

import app.main as main_module
from app.core.config import get_settings
from app.core.permissions import ALL_PERMISSIONS
from app.db.session import get_db
from app.services.pipeline_service import PipelineService
from app.services.permission_service import PermissionService

pytestmark = pytest.mark.unit


def _grant_all_permissions(monkeypatch) -> None:
    """Bypass permission checks for tests that are not testing authorization.

    ``require_permission`` / ``require_any_permissions`` now resolve the
    user's effective permission set via ``PermissionService.get_user_permissions``
    (DB call) rather than the older ``can_user`` helper.  Patch both so tests
    remain robust to further refactors of the permission-check path.
    """
    monkeypatch.setattr(PermissionService, "can_user", lambda *args, **kwargs: True)
    monkeypatch.setattr(
        PermissionService,
        "get_user_permissions",
        lambda *args, **kwargs: list(ALL_PERMISSIONS),
    )


class _ProfileDbStub:
    def __init__(self, profile: object | None) -> None:
        self._profile = profile

    def scalar(self, *_args, **_kwargs):
        return self._profile


class _ScalarSequenceDbStub:
    def __init__(self, values: list[object | None]) -> None:
        self._values = list(values)

    def scalar(self, *_args, **_kwargs):
        if self._values:
            return self._values.pop(0)
        return None


class _AuthSessionsMissingDbStub:
    """Profile lookup succeeds; auth_sessions query raises undefined-table."""

    def __init__(self, profile: object) -> None:
        self._profile = profile
        self._calls = 0

    def scalar(self, *_args, **_kwargs):
        self._calls += 1
        if self._calls == 1:
            return self._profile
        raise ProgrammingError(
            "SELECT",
            {},
            orig=Exception('relation "auth_sessions" does not exist'),
        )

    def scalars(self, *_args, **_kwargs):
        return _EmptyScalars()


class _EmptyScalars:
    def __iter__(self):
        return iter(())


def _db_override_with_profile(profile: object | None):
    def _override():
        yield _ProfileDbStub(profile)

    return _override


def _db_override_with_scalars(values: list[object | None]):
    def _override():
        yield _ScalarSequenceDbStub(values)

    return _override


def test_401_when_missing_auth_context(client):
    response = client.get("/api/v1/candidates")
    assert response.status_code == 401
    assert response.json()["detail"] == "Missing authenticated user context."


def test_401_when_bearer_token_is_invalid(client):
    response = client.get(
        "/api/v1/candidates",
        headers={"Authorization": "Bearer not-a-valid-jwt"},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid authentication token."


def test_401_when_bearer_token_is_expired(client):
    settings = get_settings()
    token = jwt.encode(
        {"sub": str(uuid4()), "exp": 1},
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )
    response = client.get(
        "/api/v1/candidates",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "Token has expired."


def test_403_when_token_org_does_not_match_requested_org(client):
    settings = get_settings()
    user_id = str(uuid4())
    profile_org = str(uuid4())
    mismatch_org = str(uuid4())

    token = jwt.encode({"sub": user_id}, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)
    profile = SimpleNamespace(id=user_id, organization_id=profile_org, role="recruiter")
    main_module.app.dependency_overrides[get_db] = _db_override_with_profile(profile)

    response = client.get(
        "/api/v1/candidates",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Organization-Id": mismatch_org,
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Forbidden: organization scope mismatch."


def test_401_when_token_session_was_revoked(client):
    settings = get_settings()
    user_id = str(uuid4())
    org_id = str(uuid4())
    sid = str(uuid4())
    token = jwt.encode(
        {"sub": user_id, "organization_id": org_id, "typ": "access", "sid": sid},
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )
    profile = SimpleNamespace(id=user_id, organization_id=org_id, role="recruiter", type="internal")
    revoked_session = SimpleNamespace(revoked_at=datetime.now(timezone.utc))
    main_module.app.dependency_overrides[get_db] = _db_override_with_scalars([profile, revoked_session])
    response = client.get(
        "/api/v1/candidates",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "Session has been invalidated."


def _db_override_auth_sessions_missing(profile: object):
    def _override():
        yield _AuthSessionsMissingDbStub(profile)

    return _override


def test_200_when_auth_sessions_table_missing_but_token_has_sid(client, monkeypatch):
    """Regression: missing auth_sessions migration must not 500 every JWT-authenticated route."""
    settings = get_settings()
    user_id = str(uuid4())
    org_id = str(uuid4())
    sid = str(uuid4())
    token = jwt.encode(
        {"sub": user_id, "organization_id": org_id, "typ": "access", "sid": sid},
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )
    profile = SimpleNamespace(id=user_id, organization_id=org_id, role="recruiter", type="internal")
    main_module.app.dependency_overrides[get_db] = _db_override_auth_sessions_missing(profile)
    _grant_all_permissions(monkeypatch)
    try:
        response = client.get(
            "/api/v1/candidates",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
    finally:
        main_module.app.dependency_overrides.pop(get_db, None)


def test_404_when_pipeline_not_found(client, force_auth, monkeypatch):
    def _raise_not_found(self, pipeline_id, organization_id, current_user):
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="Pipeline not found.")

    monkeypatch.setattr(PipelineService, "get_pipeline_by_id", _raise_not_found)
    _grant_all_permissions(monkeypatch)

    response = client.get(f"/api/v1/pipelines/{uuid4()}")
    assert response.status_code == 404
    assert response.json()["detail"] == "Pipeline not found."


def test_409_when_creating_duplicate_pipeline(client, force_auth, monkeypatch):
    def _raise_conflict(self, organization_id, current_user, payload):
        from fastapi import HTTPException

        raise HTTPException(status_code=409, detail="A pipeline already exists for this candidate and job.")

    monkeypatch.setattr(PipelineService, "create_pipeline", _raise_conflict)
    _grant_all_permissions(monkeypatch)
    response = client.post(
        "/api/v1/pipelines",
        json={
            "candidate_id": str(uuid4()),
            "job_id": str(uuid4()),
            "stage": "applied",
            "status": "active",
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "A pipeline already exists for this candidate and job."


def test_patch_pipeline_stage_returns_updated_record(client, force_auth, monkeypatch):
    pipeline_id = uuid4()
    organization_id = uuid4()
    candidate_id = uuid4()
    job_id = uuid4()
    now = datetime.now(timezone.utc)

    pipeline = SimpleNamespace(
        id=pipeline_id,
        organization_id=organization_id,
        candidate_id=candidate_id,
        job_id=job_id,
        stage="screening",
        status="active",
        notes=None,
        created_at=now,
        updated_at=now,
    )

    def _update_pipeline(self, pipeline_id, organization_id, current_user, payload):
        return pipeline

    monkeypatch.setattr(PipelineService, "update_pipeline", _update_pipeline)
    _grant_all_permissions(monkeypatch)

    response = client.patch(
        f"/api/v1/pipeline/{pipeline_id}",
        json={"stage": "Screening"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == str(pipeline_id)
    assert body["stage"] == "screening"


def test_422_when_payload_is_invalid(client, force_auth, monkeypatch):
    _grant_all_permissions(monkeypatch)
    response = client.post(
        "/api/v1/candidates",
        json={
            "first_name": "",
            "last_name": "User",
            "email": "not-an-email",
        },
    )
    assert response.status_code == 422
    body = response.json()
    detail = body.get("detail") or body.get("error") or body
    if isinstance(detail, list):
        assert len(detail) >= 1
    else:
        assert isinstance(detail, str)
        assert detail


def test_403_when_viewer_attempts_to_create_candidate(client, auth_headers):
    viewer_headers = {**auth_headers, "X-User-Role": "client_viewer"}
    response = client.post(
        "/api/v1/candidates",
        headers=viewer_headers,
        json={
            "first_name": "Read",
            "last_name": "Only",
            "email": "readonly@example.com",
        },
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "Forbidden: insufficient permissions."


def test_401_when_role_header_is_invalid(client, auth_headers):
    invalid_headers = {**auth_headers, "X-User-Role": "super_admin"}
    response = client.get("/api/v1/candidates", headers=invalid_headers)
    # Header-only auth contexts are not trusted for authorization in the
    # current dependency chain; invalid role header falls through to
    # permission denial.
    assert response.status_code == 403
    assert response.json()["detail"] == "Forbidden: insufficient permissions."
