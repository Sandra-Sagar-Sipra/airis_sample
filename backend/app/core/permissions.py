from __future__ import annotations

from collections.abc import Iterable

# Permission constants (action-based RBAC).
CANDIDATES_CREATE = "candidates:create"
CANDIDATES_READ = "candidates:read"
CANDIDATES_READ_OWN = "candidates:read_own"
CANDIDATES_UPDATE = "candidates:update"
CANDIDATES_DELETE = "candidates:delete"
CANDIDATES_MERGE = "candidates:merge"

JOBS_CREATE = "jobs:create"
JOBS_READ = "jobs:read"
JOBS_READ_LIMITED = "jobs:read_limited"
JOBS_UPDATE = "jobs:update"
JOBS_DELETE = "jobs:delete"

PIPELINE_UPDATE = "pipeline:update"
PIPELINE_READ = "pipeline:read"
PIPELINE_CREATE = "pipeline:create"

INTERVIEWS_CREATE = "interviews:create"
INTERVIEWS_READ = "interviews:read"
INTERVIEWS_UPDATE = "interviews:update"
INTERVIEWS_DELETE = "interviews:delete"
INTERVIEWS_FEEDBACK = "interviews:feedback"
INTERVIEWS_CLAIM = "interviews:claim"
INTERVIEWS_PANEL = "interviews:panel"
INTERVIEWS_COPILOT = "interviews:copilot"

ORGANIZATION_MANAGE = "organization:manage"
USERS_INVITE = "users:invite"
USERS_UPDATE_ROLE = "users:update_role"
USERS_DELETE = "users:delete"

CLIENTS_CREATE = "clients:create"
CLIENTS_READ = "clients:read"
CLIENTS_UPDATE = "clients:update"
CLIENTS_DELETE = "clients:delete"
# Dedicated permission for assigning/removing recruiters from a client workspace.
# Admins always have this; recruiters do not by default.
CLIENTS_ASSIGN = "clients:assign"
ATS_READ = "ats:read"
ATS_RESCORE = "ats:rescore"

AI_SCREENING_CREATE = "ai_screening:create"
AI_SCREENING_READ = "ai_screening:read"
AI_SCREENING_UPDATE = "ai_screening:update"
AI_SCREENING_DELETE = "ai_screening:delete"
AI_SCREENING_EVALUATE = "ai_screening:evaluate"

AI_INTERVIEW_QUESTIONS_GENERATE = "ai_interview_questions:generate"

# Vendor-scoped permissions.
SUBMISSIONS_CREATE = "submissions:create"
SUBMISSIONS_READ_OWN = "submissions:read_own"

ALL_PERMISSIONS: tuple[str, ...] = (
    CANDIDATES_CREATE,
    CANDIDATES_READ,
    CANDIDATES_READ_OWN,
    CANDIDATES_UPDATE,
    CANDIDATES_DELETE,
    CANDIDATES_MERGE,
    JOBS_CREATE,
    JOBS_READ,
    JOBS_READ_LIMITED,
    JOBS_UPDATE,
    JOBS_DELETE,
    PIPELINE_UPDATE,
    PIPELINE_READ,
    PIPELINE_CREATE,
    INTERVIEWS_CREATE,
    INTERVIEWS_READ,
    INTERVIEWS_UPDATE,
    INTERVIEWS_DELETE,
    INTERVIEWS_FEEDBACK,
    INTERVIEWS_CLAIM,
    INTERVIEWS_PANEL,
    INTERVIEWS_COPILOT,
    ORGANIZATION_MANAGE,
    USERS_INVITE,
    USERS_UPDATE_ROLE,
    USERS_DELETE,
    CLIENTS_CREATE,
    CLIENTS_READ,
    CLIENTS_UPDATE,
    CLIENTS_DELETE,
    CLIENTS_ASSIGN,
    ATS_READ,
    ATS_RESCORE,
    AI_SCREENING_CREATE,
    AI_SCREENING_READ,
    AI_SCREENING_UPDATE,
    AI_SCREENING_DELETE,
    AI_SCREENING_EVALUATE,
    SUBMISSIONS_CREATE,
    SUBMISSIONS_READ_OWN,
    AI_INTERVIEW_QUESTIONS_GENERATE,
)


def normalize_permissions(values: Iterable[str]) -> list[str]:
    allowed = set(ALL_PERMISSIONS)
    normalized = []
    for value in values:
        permission = value.strip().lower()
        if permission in allowed:
            normalized.append(permission)
    return sorted(set(normalized))
