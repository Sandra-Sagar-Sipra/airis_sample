import threading
import time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import logging

from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import get_cors_origins, get_settings
from app.core.openapi import build_custom_openapi, is_docs_enabled
from app.candidate_management.api import router as candidate_management_router
from app.routes.auth import router as auth_router
from app.routes.ats import router as ats_router
from app.routes.candidate import router as candidate_router
from app.routes.candidate_notes import router as candidate_notes_router
from app.routes.client import router as client_router
from app.routes.health import router as health_router
from app.routes.interview import router as interview_router
from app.routes.interview_copilot import router as interview_copilot_router
from app.routes.ai_screening import router as ai_screening_router
from app.websocket.copilot_ws import ws_router as copilot_ws_router
from app.routes.invites import router as invites_router
from app.routes.job import router as job_router
from app.routes.me import router as me_router
from app.routes.pipeline import pipeline_router as pipeline_singular_router
from app.routes.permission_catalog import router as permission_catalog_router
from app.routes.pipeline import router as pipeline_router
from app.routes.application import router as application_router
from app.routes.roles import router as roles_router
from app.routes.users import router as users_router
from app.routes.vendor import router as vendor_router
from app.routes.dashboard import router as dashboard_router
from app.routes.pipeline_analytics import router as pipeline_analytics_router
from app.routes.offer import router as offer_router
from app.routes.sourcing import router as sourcing_router
from app.routes.ai_interview_questions import router as ai_interview_questions_router

settings = get_settings()
logger = logging.getLogger(__name__)

# ── API docs visibility ───────────────────────────────────────────────────────
# /docs (Swagger UI) and /redoc are DISABLED in production by default.
# Override with DOCS_ENABLED=true in the environment for intentional access.
# See app/core/openapi.py for the full decision logic.
_docs_on = is_docs_enabled(settings)
if not _docs_on:
    logger.info(
        "API docs disabled (APP_ENV=%s). Set DOCS_ENABLED=true to enable.",
        settings.app_env,
    )

app = FastAPI(
    title=settings.app_name,
    debug=settings.debug,
    # Expose /docs, /redoc, /openapi.json only in non-production environments.
    docs_url="/docs" if _docs_on else None,
    redoc_url="/redoc" if _docs_on else None,
    openapi_url="/openapi.json" if _docs_on else None,
)

# ── Custom OpenAPI schema (BearerAuth, error schemas, tag descriptions) ───────
# Registered after app creation so routes are available when the schema is built.
# The callable is invoked lazily on the first request to /openapi.json.
app.openapi = build_custom_openapi(app, settings)  # type: ignore[method-assign]


@app.get("/", tags=["health"])
def root() -> dict[str, str]:
    """Lightweight liveness probe for platform healthchecks that hit `/`."""
    return {"status": "ok", "service": settings.app_name}


# Step 2: ADD CORS (TOP LEVEL)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_origins(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_ALLOWED_ORIGINS = set(get_cors_origins(settings.cors_origins))


def _cors_headers_for_request(request: Request) -> dict[str, str]:
    """
    When returning JSON error responses, ensure CORS headers match the incoming
    `Origin` (or return nothing). This avoids browsers rejecting responses due
    to `Access-Control-Allow-Origin` not matching the request origin.
    """
    origin = request.headers.get("origin")
    if origin and origin in _ALLOWED_ORIGINS:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
        }
    return {}

from fastapi.exceptions import RequestValidationError, ResponseValidationError


def _http_exception_payload(detail: object) -> object:
    """Ensure JSON-serializable body for HTTPException (str, list, or dict)."""
    if detail is None:
        return None
    if isinstance(detail, (str, int, float, bool)):
        return detail
    if isinstance(detail, (list, dict)):
        return detail
    return str(detail)


@app.exception_handler(StarletteHTTPException)
async def starlette_http_exception_handler(request: Request, exc: StarletteHTTPException):
    """Must be registered so Starlette does not fall through to the generic
    `Exception` handler (HTTPException subclasses Exception — MRO would match
    `Exception` and turn every 401/403/404 into a 500 otherwise).
    """
    logger.warning(
        "http_exception",
        extra={
            "path": str(request.url.path),
            "method": request.method,
            "status_code": exc.status_code,
            "detail_preview": str(exc.detail)[:300] if exc.detail is not None else "",
        },
    )
    headers = _cors_headers_for_request(request)
    exc_headers = getattr(exc, "headers", None)
    if exc_headers is not None:
        headers = {**headers, **exc_headers}
    return JSONResponse(
        status_code=exc.status_code,
        headers=headers,
        content={"detail": _http_exception_payload(exc.detail)},
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        headers=_cors_headers_for_request(request),
        content={
            "success": False,
            "error": "Validation Error",
            "details": exc.errors()
        }
    )

@app.exception_handler(ResponseValidationError)
async def response_validation_exception_handler(request: Request, exc: ResponseValidationError):
    # Safely extract errors — exc.errors() can itself throw on some Pydantic builds.
    try:
        errors = exc.errors()
    except Exception:
        errors = repr(exc)
    logger.error(
        "response_validation_failed",
        extra={
            "path": str(request.url.path),
            "method": request.method,
            "exception_type": type(exc).__name__,
        },
        exc_info=exc,
    )
    return JSONResponse(
        status_code=500,
        headers=_cors_headers_for_request(request),
        content={
            "success": False,
            "detail": "Response serialization error.",
            "error": str(errors)[:500],
            "exception_type": "ResponseValidationError",
        },
    )

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    # Belt-and-suspenders: never handle HTTPException here (see MRO note above).
    if isinstance(exc, StarletteHTTPException):
        return await starlette_http_exception_handler(request, exc)

    logger.exception(
        "unhandled_api_exception",
        extra={
            "path": str(request.url.path),
            "method": request.method,
            "exception_type": type(exc).__name__,
            "query": str(request.url.query)[:500],
        },
    )
    safe_message = str(exc).strip() or repr(exc)
    # Avoid non-JSON-serializable payloads breaking the error response itself.
    if len(safe_message) > 2000:
        safe_message = safe_message[:2000] + "…"
    return JSONResponse(
        status_code=500,
        headers=_cors_headers_for_request(request),
        content={
            "success": False,
            "detail": "Internal server error",
            "error": safe_message,
            "exception_type": type(exc).__name__,
        },
    )

@app.middleware("http")
async def request_timing_middleware(request: Request, call_next):
    t0 = time.monotonic()
    response = await call_next(request)
    duration_ms = int((time.monotonic() - t0) * 1000)
    response.headers["X-Response-Time"] = f"{duration_ms}ms"
    if duration_ms > 500:
        logger.warning(
            "slow_request",
            extra={
                "method": request.method,
                "path": request.url.path,
                "duration_ms": duration_ms,
                "status_code": response.status_code,
            },
        )
    return response


@app.on_event("startup")
async def _capture_event_loop() -> None:
    """Store the main asyncio event loop so background threads can schedule
    coroutines (e.g. WebSocket notifications) onto it."""
    import asyncio
    from app.services import copilot_service
    copilot_service._main_event_loop = asyncio.get_running_loop()


@app.on_event("startup")
def startup_event() -> None:
    # Permission backfill hits the DB for every org; run off the critical path so
    # uvicorn can accept traffic immediately (reflection is lazy — see reflected.py).
    threading.Thread(
        target=_backfill_permissions,
        name="permission-backfill",
        daemon=True,
    ).start()
    # PIPE-008: start background offer expiry scheduler.
    from app.scheduler import start_offer_expiry_scheduler
    start_offer_expiry_scheduler()


@app.on_event("shutdown")
def shutdown_event() -> None:
    from app.scheduler import stop_offer_expiry_scheduler
    from app.services.task_runner import shutdown_task_runner

    stop_offer_expiry_scheduler()
    shutdown_task_runner(wait=False)


def _backfill_permissions() -> None:
    """Idempotently propagate new permissions to all existing org roles."""
    from app.core.signup_permissions import backfill_all_organizations
    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        backfill_all_organizations(db)
    except Exception:
        logger.exception("startup.permission_backfill_failed — permissions may be missing for some orgs")
    finally:
        db.close()


app.include_router(health_router, prefix="/api/v1")
app.include_router(auth_router, prefix="/api/v1")
app.include_router(me_router, prefix="/api/v1")
app.include_router(candidate_router, prefix="/api/v1")
app.include_router(candidate_notes_router, prefix="/api/v1")
app.include_router(candidate_management_router, prefix="/api/v1/candidate-management")
app.include_router(client_router, prefix="/api/v1")
app.include_router(job_router, prefix="/api/v1")
app.include_router(ats_router, prefix="/api/v1")
app.include_router(pipeline_router, prefix="/api/v1")
app.include_router(pipeline_singular_router, prefix="/api/v1")
app.include_router(application_router, prefix="/api/v1")
app.include_router(interview_router, prefix="/api/v1")
app.include_router(interview_copilot_router, prefix="/api/v1")
app.include_router(copilot_ws_router, prefix="/api/v1")
app.include_router(ai_screening_router, prefix="/api/v1")
app.include_router(invites_router, prefix="/api/v1/invites", tags=["invites"])
app.include_router(permission_catalog_router, prefix="/api/v1")
app.include_router(roles_router, prefix="/api/v1/roles", tags=["roles"])
app.include_router(users_router, prefix="/api/v1/users", tags=["users"])
app.include_router(vendor_router, prefix="/api/v1")
app.include_router(dashboard_router, prefix="/api/v1")
app.include_router(pipeline_analytics_router, prefix="/api/v1")
app.include_router(offer_router, prefix="/api/v1")
app.include_router(sourcing_router, prefix="/api/v1/sourcing", tags=["sourcing"])
app.include_router(ai_interview_questions_router, prefix="/api/v1")

