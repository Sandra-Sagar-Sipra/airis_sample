"""FastAPI lifespan: startup hooks and ordered shutdown cleanup."""
from __future__ import annotations

import asyncio
import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.core.config import get_settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def app_lifespan(app: FastAPI):
    import asyncio as aio

    from app.core.shutdown import mark_shutting_down
    from app.scheduler import start_offer_expiry_scheduler, stop_offer_expiry_scheduler
    from app.services import copilot_service
    from app.services.copilot_service import cancel_pending_ws_notifications
    from app.services.task_runner import shutdown_task_runner
    from app.websocket.registry import shutdown_all_websockets

    settings = get_settings()
    copilot_service._main_event_loop = aio.get_running_loop()

    threading.Thread(
        target=_backfill_permissions,
        name="permission-backfill",
        daemon=True,
    ).start()
    start_offer_expiry_scheduler()

    logger.info("lifespan.startup_complete app=%s", settings.app_name)
    try:
        yield
    finally:
        logger.info("lifespan.shutdown_begin")
        mark_shutting_down()

        stop_offer_expiry_scheduler()
        shutdown_task_runner(wait=False)
        cancel_pending_ws_notifications()

        try:
            await asyncio.wait_for(shutdown_all_websockets(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("lifespan.websocket_shutdown_timed_out")
        except Exception:
            logger.exception("lifespan.websocket_shutdown_failed")

        loop = copilot_service._main_event_loop
        copilot_service._main_event_loop = None
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(lambda: None)

        logger.info("lifespan.shutdown_complete")


def _backfill_permissions() -> None:
    from app.core.shutdown import is_shutting_down
    from app.core.signup_permissions import backfill_all_organizations
    from app.db.session import SessionLocal

    if is_shutting_down():
        return

    db = SessionLocal()
    try:
        backfill_all_organizations(db)
    except Exception:
        logger.exception(
            "startup.permission_backfill_failed — permissions may be missing for some orgs"
        )
    finally:
        db.close()
