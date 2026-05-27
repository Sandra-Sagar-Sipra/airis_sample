"""INFRA-006: Shared Celery application for AIRIS async background jobs.

All task modules import `celery_app` from here.  Never instantiate a second
Celery() object — that would give each module its own broker connection pool
and break queue routing.

Queue topology
--------------
ai              AI-heavy work: ATS scoring, semantic matching, sourcing sessions
email           Transactional emails (invite, notification, reminder)
notifications   Lightweight in-app / push notifications
integrations    Third-party sync: Google Calendar, MS Calendar
background      Low-priority catch-all (analytics, housekeeping)
deadletter      Terminal failures routed here for inspection / alerting

Worker launch examples
----------------------
# All queues in dev:
  celery -A app.celery_app.celery_app worker --loglevel=info -Q ai,email,notifications,integrations,background

# AI-only worker (CPU-intensive isolation):
  celery -A app.celery_app.celery_app worker --loglevel=info -Q ai -c 2

# Beat scheduler (invite reminders, expiry sweeps):
  celery -A app.celery_app.celery_app beat --loglevel=info

# Flower monitoring:
  celery -A app.celery_app.celery_app flower --port=5555
"""
from __future__ import annotations

import logging
import time
from typing import Any

from celery import Celery
from celery.signals import (
    task_failure,
    task_postrun,
    task_prerun,
    task_retry,
    worker_ready,
    worker_shutdown,
)
from kombu import Exchange, Queue

logger = logging.getLogger(__name__)

# ── Queue names ───────────────────────────────────────────────────────────────
QUEUE_AI = "ai"
QUEUE_EMAIL = "email"
QUEUE_NOTIFICATIONS = "notifications"
QUEUE_INTEGRATIONS = "integrations"
QUEUE_BACKGROUND = "background"
QUEUE_DEADLETTER = "deadletter"

ALL_QUEUES = [
    QUEUE_AI,
    QUEUE_EMAIL,
    QUEUE_NOTIFICATIONS,
    QUEUE_INTEGRATIONS,
    QUEUE_BACKGROUND,
    QUEUE_DEADLETTER,
]


def _build_queues() -> list[Queue]:
    default_exchange = Exchange("default", type="direct")
    return [Queue(name, default_exchange, routing_key=name) for name in ALL_QUEUES]


def create_celery_app() -> Celery:
    """Construct and configure the shared Celery application."""
    from app.core.config import get_settings

    settings = get_settings()

    app = Celery(
        "airis",
        broker=settings.celery_broker_url,
        backend=settings.celery_result_backend,
        include=[
            "app.tasks.email_tasks",
            "app.tasks.ai_tasks",
            "app.tasks.notification_tasks",
            "app.tasks.integration_tasks",
            "app.tasks.invite_tasks",
            "app.tasks.dlq_tasks",
            "app.tasks.interview_reminder_tasks",  # SCHED-006
            "app.candidate_management.tasks",
        ],
    )

    app.conf.update(
        # Serialisation
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        # Time
        timezone="UTC",
        enable_utc=True,
        # Reliability
        task_track_started=True,
        task_acks_late=True,          # Ack after completion (survive worker crash)
        worker_prefetch_multiplier=1,  # Fair scheduling across queues
        # Timeouts (overridable per-task)
        task_soft_time_limit=300,      # 5 min — raises SoftTimeLimitExceeded
        task_time_limit=360,           # 6 min — hard kill
        # Queues
        task_default_queue=QUEUE_BACKGROUND,
        task_queues=_build_queues(),
        task_routes={
            "app.tasks.email_tasks.*": {"queue": QUEUE_EMAIL},
            "app.tasks.invite_tasks.*": {"queue": QUEUE_EMAIL},
            "app.tasks.ai_tasks.*": {"queue": QUEUE_AI},
            "app.candidate_management.tasks.*": {"queue": QUEUE_AI},
            "app.tasks.notification_tasks.*": {"queue": QUEUE_NOTIFICATIONS},
            "app.tasks.integration_tasks.*": {"queue": QUEUE_INTEGRATIONS},
            # SCHED-006 — sweep runs on background; per-reminder send on email
            "app.tasks.interview_reminder_tasks.sweep_interview_reminders": {"queue": QUEUE_BACKGROUND},
            "app.tasks.interview_reminder_tasks.send_single_interview_reminder": {"queue": QUEUE_EMAIL},
        },
        # Default retry policy applied to tasks that don't set their own
        task_default_retry_delay=10,
        # Beat schedule (periodic tasks)
        beat_schedule={
            "infra006-invite-reminders-hourly": {
                "task": "app.tasks.invite_tasks.send_invite_reminders",
                "schedule": 3600,  # Every hour
                "options": {"queue": QUEUE_EMAIL},
            },
            "finv05-sweep-expired-invites-hourly": {
                "task": "app.tasks.invite_tasks.sweep_expired_invites",
                "schedule": 3600,  # Every hour — F-INV-05 expiry sweep
                "options": {"queue": QUEUE_BACKGROUND},
            },
            # SCHED-006: interview reminder sweep — runs every 5 minutes so reminders
            # fire within 5 min of their scheduled_for time.
            "sched006-interview-reminder-sweep": {
                "task": "app.tasks.interview_reminder_tasks.sweep_interview_reminders",
                "schedule": 300,  # 5 minutes
                "options": {"queue": QUEUE_BACKGROUND},
            },
        },
        # Result expiry
        result_expires=86400,  # 24 h
    )

    return app


celery_app: Celery = create_celery_app()

# ── Structured task logging (AIR-237) ─────────────────────────────────────────
# Celery signals attach at module load time; they apply to every task.

_TASK_START_ATTR = "_airis_start_t"


@task_prerun.connect
def _on_task_prerun(
    task_id: str,
    task: Any,
    args: tuple,
    kwargs: dict,
    **_: Any,
) -> None:
    setattr(task, _TASK_START_ATTR, time.monotonic())
    logger.info(
        "task.start",
        extra={
            "task_id": task_id,
            "task_name": task.name,
            "queue": getattr(task, "queue", task.request.delivery_info.get("routing_key", "unknown") if task.request else "unknown"),
            "retries": task.request.retries if task.request else 0,
        },
    )


@task_postrun.connect
def _on_task_postrun(
    task_id: str,
    task: Any,
    retval: Any,
    state: str,
    **_: Any,
) -> None:
    start = getattr(task, _TASK_START_ATTR, None)
    duration_ms = int((time.monotonic() - start) * 1000) if start is not None else -1
    logger.info(
        "task.complete",
        extra={
            "task_id": task_id,
            "task_name": task.name,
            "state": state,
            "duration_ms": duration_ms,
            "retries": task.request.retries if task.request else 0,
        },
    )


@task_retry.connect
def _on_task_retry(
    request: Any,
    reason: Any,
    einfo: Any,
    **_: Any,
) -> None:
    logger.warning(
        "task.retry",
        extra={
            "task_id": request.id,
            "task_name": request.task,
            "retries": request.retries,
            "reason": str(reason)[:500],
        },
    )


@task_failure.connect
def _on_task_failure(
    task_id: str,
    exception: Exception,
    traceback: Any,
    sender: Any,
    einfo: Any,
    **_: Any,
) -> None:
    """Called when a task fails permanently (retries exhausted or non-retried exc).

    Routes the failed task payload to the dead-letter queue (AIR-234).
    """
    logger.error(
        "task.failed",
        extra={
            "task_id": task_id,
            "task_name": getattr(sender, "name", "unknown"),
            "error": str(exception)[:1000],
            "error_type": type(exception).__name__,
            "retries": getattr(sender.request, "retries", -1) if hasattr(sender, "request") else -1,
        },
        exc_info=einfo.exc_info if einfo else None,
    )
    # ── Dead-letter queue routing (AIR-234) ────────────────────────────────
    try:
        _route_to_deadletter(task_id=task_id, sender=sender, exception=exception)
    except Exception:
        logger.warning("task.dlq_route_failed", extra={"task_id": task_id}, exc_info=True)


def _route_to_deadletter(task_id: str, sender: Any, exception: Exception) -> None:
    """Publish a dead-letter record so failed tasks are inspectable."""
    import datetime

    payload = {
        "task_id": task_id,
        "task_name": getattr(sender, "name", "unknown"),
        "error": str(exception)[:2000],
        "error_type": type(exception).__name__,
        "retries": getattr(sender.request, "retries", -1) if hasattr(sender, "request") else -1,
        "args": str(getattr(sender.request, "args", []))[:500] if hasattr(sender, "request") else "",
        "kwargs": str(getattr(sender.request, "kwargs", {}))[:500] if hasattr(sender, "request") else "",
        "failed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    celery_app.send_task(
        "app.tasks.dlq_tasks.record_dead_letter",
        kwargs=payload,
        queue=QUEUE_DEADLETTER,
    )


@worker_ready.connect
def _on_worker_ready(sender: Any, **_: Any) -> None:
    logger.info("celery.worker_ready", extra={"hostname": getattr(sender, "hostname", "unknown")})


@worker_shutdown.connect
def _on_worker_shutdown(sender: Any, **_: Any) -> None:
    logger.info("celery.worker_shutdown", extra={"hostname": getattr(sender, "hostname", "unknown")})
