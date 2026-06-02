from collections.abc import Generator
from contextlib import contextmanager
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.core.config import get_settings

settings = get_settings()

# ── pgBouncer / Supabase compatibility ────────────────────────────────────────
#
# Supabase pooler (pooler.supabase.com) multiplexes many app connections over a
# small set of real Postgres connections. SQLAlchemy must NOT maintain its own
# connection pool on top of the pooler — that exhausts checkout slots and causes:
#   ECHECKOUTTIMEOUT unable to check out connection from the pool after 60000ms
#
# Use NullPool for all Supabase pooler URLs (ports 5432 session mode and 6543
# transaction mode). Each request opens a connection and releases it immediately.
#
# prepare_threshold=None disables psycopg v3 server-side prepared statements, which
# break when the pooler reuses underlying connections across clients.

_db_url = settings.database_url or ""
if _db_url.startswith("postgresql://") and "+psycopg" not in _db_url.split("://", 1)[0]:
    _db_url = _db_url.replace("postgresql://", "postgresql+psycopg://", 1)

_use_supabase_pooler = "pooler.supabase.com" in _db_url

_engine_kwargs: dict = {
    "future": True,
    "hide_parameters": True,
}

if _use_supabase_pooler:
    # NullPool: every request opens and immediately closes its own connection.
    # No SQLAlchemy connection pool on top of pgBouncer — avoids slot exhaustion.
    _engine_kwargs["poolclass"] = NullPool
    # prepare_threshold=None disables psycopg server-side prepared statements.
    # Required for pgBouncer transaction mode; harmless for session mode.
    _engine_kwargs["connect_args"] = {"prepare_threshold": None}
else:
    _engine_kwargs["pool_pre_ping"] = True
    _engine_kwargs["pool_size"] = 5
    _engine_kwargs["max_overflow"] = 10

engine = create_engine(_db_url, **_engine_kwargs)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
    expire_on_commit=False,
    class_=Session,
)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    except BaseException:
        try:
            db.rollback()
        except Exception:
            pass
        raise
    finally:
        db.close()


@contextmanager
def db_session() -> Generator[Session, None, None]:
    """Short-lived session for WebSockets and background work (always closes)."""
    db = SessionLocal()
    try:
        yield db
    except BaseException:
        try:
            db.rollback()
        except Exception:
            pass
        raise
    finally:
        db.close()
