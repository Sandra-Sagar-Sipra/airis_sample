# AIRIS Backend Scaffold

Production-oriented FastAPI backend scaffold with:
- modular architecture (`app/models`, `app/schemas`, `app/routes`, `app/services`, `app/db`)
- SQLAlchemy + PostgreSQL (Supabase-compatible)
- env-based DB config (`DATABASE_URL`)
- Alembic migration setup with baseline for existing DB
- runtime schema reflection (read-only, no DB structure changes)

## 1) Setup

```bash
cd backend
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
```

Set `DATABASE_URL` in `.env`.

## 2) Run API

```bash
uvicorn app.main:app --reload
```

Health endpoint:
- `GET /api/v1/health`

### Railway deployment

Set the service **root directory** to `backend`.

| Setting | Value |
|---------|--------|
| Builder | **Nixpacks** (default — do not use a custom Dockerfile) |
| Build command | *(leave empty — Nixpacks installs from `requirements.txt`)* |
| Start command | `uvicorn app.main:app --host 0.0.0.0 --port $PORT` |
| Health check | `/api/v1/health` |

Railway auto-detects Python from **`requirements.txt`** and **`runtime.txt`** (`python-3.11.11`). Use the **Nixpacks** builder (see `nixpacks.toml`). Do not add `.python-version` — Railpack/mise may fail on older patch releases missing GitHub artifact attestations.

**Important:** Do not commit virtualenvs (`.venv*`). An old Windows `pip freeze` in git history contained `pywin32==311` / `pypiwin32==223`; the current `requirements.txt` does not. After pulling, redeploy with **clear build cache**.

Validate locally: `python scripts/check-requirements-linux.py` then `pip install -r requirements.txt`.

**Secrets:** set `DATABASE_URL`, `JWT_SECRET_KEY`, etc. only in the Railway service **Variables** tab (never in Dockerfile, `ARG`, or build-time `ENV`).

Do **not** use the old Windows pip-freeze `requirements.txt` — use the current file that includes `requirements-prod.txt`.

## 3) Reflection (existing Supabase schema)

At startup, `app.models.reflected.reflect_database_schema()` reflects your current DB schema into ORM classes using SQLAlchemy automap.

Optional: generate a quick snapshot of reflected models:

```bash
python scripts/generate_reflection_snapshot.py
```

## 4) Alembic Workflow

This project is configured for an existing database.

### First-time baseline on existing DB

```bash
alembic stamp head
```

This marks the database at baseline revision without modifying tables.

### Generate future migrations

```bash
alembic revision --autogenerate -m "describe change"
alembic upgrade head
```

### Migration safety rules

- Do not run raw SQL DDL manually for tracked schema changes.
- Always create a migration file, review it, then apply via Alembic.
- Validate on staging before production.

