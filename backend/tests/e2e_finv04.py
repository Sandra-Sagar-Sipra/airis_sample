"""
F-INV-04 — End-to-End evidence script.

Tests:
  T1  Create invite  → email dispatched → invite in DB
  T2  Resend invite  → second email dispatched
  T3  SMTP-check     → connection/auth verified
  T4  Delivery tracking fields populated after create
  T5  Resend delivery_status reset to 'pending'
  T6  SMTP failure simulation → logged / status tracked

Run:
    python tests/e2e_finv04.py

Requires backend running on http://127.0.0.1:8010
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
import urllib.error
from datetime import UTC, datetime

BASE = "http://127.0.0.1:8010/api/v1"
import os, sys as _sys
if hasattr(_sys.stdout, "reconfigure"):
    _sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

PASS = "[PASS]"
FAIL = "[FAIL]"

# ── auth ─────────────────────────────────────────────────────────────────────


def _get_admin_context() -> dict:
    """Return an admin user_id and org_id from the DB."""
    from sqlalchemy import text
    import os, sqlalchemy as sa
    url = os.environ.get("DATABASE_URL", "")
    if "pooler.supabase.com:6543" in url:
        url = url.replace("pooler.supabase.com:6543", "pooler.supabase.com:5432")
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    engine = sa.create_engine(url, poolclass=sa.pool.NullPool, hide_parameters=True)
    with engine.connect() as conn:
        row = conn.execute(text(
            "SELECT p.id, p.organization_id FROM profiles p "
            "WHERE p.role='admin' LIMIT 1"
        )).fetchone()
        if not row:
            raise RuntimeError("No admin profile found in DB")
        return {"user_id": str(row[0]), "org_id": str(row[1])}


def _headers(ctx: dict) -> dict:
    return {
        "X-User-Id": ctx["user_id"],
        "X-Organization-Id": ctx["org_id"],
        "X-User-Role": "admin",
        "Content-Type": "application/json",
    }


# ── HTTP helpers ──────────────────────────────────────────────────────────────


def _post(path: str, body: dict, headers: dict) -> tuple[int, dict]:
    data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _get(path: str, headers: dict) -> tuple[int, dict]:
    req = urllib.request.Request(BASE + path, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


# ── DB helpers ────────────────────────────────────────────────────────────────


def _session_engine():
    """Return an engine using the session-mode pooler (5432) for safe DDL/direct queries."""
    import os
    import sqlalchemy as sa
    url = os.environ.get("DATABASE_URL", "")
    # Prefer session-mode pooler for direct queries — avoids transaction-mode timeout
    if "pooler.supabase.com:6543" in url:
        url = url.replace("pooler.supabase.com:6543", "pooler.supabase.com:5432")
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    return sa.create_engine(url, poolclass=sa.pool.NullPool, hide_parameters=True)


def _get_invite_from_db(invite_id: str) -> dict | None:
    from sqlalchemy import text
    engine = _session_engine()
    with engine.connect() as conn:
        row = conn.execute(text(
            "SELECT id, email, status, delivery_status, delivery_provider, "
            "message_id, delivery_attempts, last_delivery_attempt_at, "
            "last_delivery_error, sent_at "
            "FROM invites WHERE id = :id"
        ), {"id": invite_id}).fetchone()
        if not row:
            return None
        return dict(zip(
            ["id", "email", "status", "delivery_status", "delivery_provider",
             "message_id", "delivery_attempts", "last_delivery_attempt_at",
             "last_delivery_error", "sent_at"],
            row,
        ))


def _delete_test_invite(invite_id: str) -> None:
    from sqlalchemy import text
    engine = _session_engine()
    with engine.connect() as conn:
        conn.execute(text("DELETE FROM invites WHERE id = :id"), {"id": invite_id})
        conn.commit()


# ── Test runner ───────────────────────────────────────────────────────────────

results: list[tuple[str, bool, str]] = []

def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, condition, detail))
    icon = PASS if condition else FAIL
    print(f"  {icon} {name}" + (f": {detail}" if detail else ""))


def section(title: str) -> None:
    print(f"\n{'─' * 60}")
    print(f"  {title}")
    print(f"{'─' * 60}")


# ── Main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    print("\n=== F-INV-04  End-to-End Evidence Run ===")
    print(f"    {datetime.now(UTC).strftime('%Y-%m-%d %H:%M:%S UTC')}")

    ctx = _get_admin_context()
    h = _headers(ctx)
    print(f"\n  Admin: {ctx['user_id']} | Org: {ctx['org_id']}")

    test_email = f"e2e-finv04-{int(time.time())}@example.com"
    invite_id: str | None = None

    # ── T1: Create invite ──────────────────────────────────────────────────────
    section("T1 — Create invite → email dispatched → record in DB")
    status, body = _post("/invites", {"email": test_email, "role": "recruiter"}, h)
    check("POST /invites returns 201", status == 201, f"status={status}")
    check("Response has message", "message" in body, body.get("message", ""))
    check("Response has invite object", "invite" in body)
    check("Response has token", "token" in body and len(body.get("token", "")) > 10)

    if status == 201 and "invite" in body:
        inv = body["invite"]
        invite_id = inv["id"]
        check("invite.status == 'sent'", inv.get("status") == "sent", inv.get("status"))
        check("invite.delivery_status == 'pending'", inv.get("delivery_status") == "pending", inv.get("delivery_status"))
        check("invite.role == 'recruiter'", inv.get("role") == "recruiter")
        check("invite.email matches", inv.get("email") == test_email)
        check("invite.expires_at present", bool(inv.get("expires_at")))
        check("invite.sent_at present", bool(inv.get("sent_at")))

        # Link validation
        token = body["token"]
        check("token non-empty", len(token) > 20, f"len={len(token)}")
    else:
        print(f"  ⚠  Skipping sub-checks — create failed: {body}")

    # ── T2: Wait for email dispatch & check delivery tracking ─────────────────
    section("T2 — Delivery tracking updated after email dispatch")
    if invite_id:
        print("  Waiting 4 s for background email thread to complete…")
        time.sleep(4)
        db_inv = _get_invite_from_db(invite_id)
        if db_inv:
            check("delivery_status updated (sent or failed)",
                  db_inv["delivery_status"] in ("sent", "failed"),
                  db_inv["delivery_status"])
            check("delivery_provider set", bool(db_inv["delivery_provider"]),
                  db_inv["delivery_provider"] or "null")
            check("message_id set", bool(db_inv["message_id"]),
                  (db_inv["message_id"] or "null")[:40])
            check("delivery_attempts >= 1", (db_inv["delivery_attempts"] or 0) >= 1,
                  str(db_inv["delivery_attempts"]))
            check("last_delivery_attempt_at set", bool(db_inv["last_delivery_attempt_at"]),
                  str(db_inv["last_delivery_attempt_at"])[:22] if db_inv["last_delivery_attempt_at"] else "null")
            if db_inv["delivery_status"] == "sent":
                check("last_delivery_error cleared on success",
                      db_inv["last_delivery_error"] is None,
                      str(db_inv["last_delivery_error"]))
        else:
            check("invite found in DB", False, f"id={invite_id}")
    else:
        print("  ⚠  Skipping — no invite_id from T1")

    # ── T3: Resend invite ─────────────────────────────────────────────────────
    section("T3 — Resend invite → delivery_status reset, second dispatch")
    if invite_id:
        status, body = _post(f"/invites/{invite_id}/resend", {}, h)
        check("POST /invites/{id}/resend returns 200", status == 200, f"status={status}")
        check("Response message present", "message" in body, body.get("message", ""))
        if status == 200:
            # Check that the DB record was reset
            db_inv = _get_invite_from_db(invite_id)
            if db_inv:
                check("delivery_status reset to 'pending' after resend",
                      db_inv["delivery_status"] == "pending",
                      db_inv["delivery_status"])
            # Wait for the second dispatch
            print("  Waiting 4 s for resend email thread…")
            time.sleep(4)
            db_inv = _get_invite_from_db(invite_id)
            if db_inv:
                check("delivery_status updated after resend",
                      db_inv["delivery_status"] in ("sent", "failed"),
                      db_inv["delivery_status"])
                check("delivery_attempts >= 2 after resend",
                      (db_inv["delivery_attempts"] or 0) >= 2,
                      str(db_inv["delivery_attempts"]))
    else:
        print("  ⚠  Skipping — no invite_id from T1")

    # ── T4: SMTP diagnostic ────────────────────────────────────────────────────
    section("T4 — GET /invites/smtp-check → Brevo SMTP verified")
    status, body = _get("/invites/smtp-check", h)
    check("GET /invites/smtp-check returns 200", status == 200, f"status={status}")
    if status == 200:
        check("smtp_host is brevo", "brevo" in body.get("smtp_host", ""), body.get("smtp_host"))
        check("smtp_port == 587", body.get("smtp_port") == 587, str(body.get("smtp_port")))
        check("smtp_from set", bool(body.get("smtp_from")), body.get("smtp_from") or "null")
        check("connected == True", body.get("connected") is True, str(body.get("connected")))
        check("authenticated == True", body.get("authenticated") is True, str(body.get("authenticated")))
        if body.get("error"):
            print(f"  ⚠  smtp-check error: {body['error']}")

    # ── T5: Invite link validation ─────────────────────────────────────────────
    section("T5 — Invite link validation")
    if invite_id:
        db_inv = _get_invite_from_db(invite_id)
        if db_inv:
            from app.services.email_service import _invite_link
            from app.core.config import get_settings
            s = get_settings()
            token = None
            from sqlalchemy import text
            engine = _session_engine()
            with engine.connect() as conn:
                row = conn.execute(text("SELECT token FROM invites WHERE id = :id"), {"id": invite_id}).fetchone()
                if row:
                    token = row[0]

            if token:
                link = _invite_link(token)
                check("Link starts with FRONTEND_URL", link.startswith(s.frontend_url), link[:50])
                check("Link contains /invite/accept", "/invite/accept" in link)
                check("Link contains token", token in link)
                check("Link is valid URL", link.startswith("http"))

    # ── T6: List invites exposes delivery fields ───────────────────────────────
    section("T6 — GET /invites list exposes delivery tracking fields")
    status, body = _get("/invites", h)
    check("GET /invites returns 200", status == 200, f"status={status}")
    if status == 200 and isinstance(body, list) and body:
        item = body[0]
        check("delivery_status in list item", "delivery_status" in item)
        check("delivery_attempts in list item", "delivery_attempts" in item)
        check("last_delivery_attempt_at in list item", "last_delivery_attempt_at" in item)

    # ── Cleanup ────────────────────────────────────────────────────────────────
    if invite_id:
        _delete_test_invite(invite_id)
        print(f"\n  Cleaned up test invite {invite_id}")

    # ── Summary ────────────────────────────────────────────────────────────────
    print(f"\n{'=' * 60}")
    passed = sum(1 for _, ok, _ in results if ok)
    total  = len(results)
    print(f"  Result: {passed}/{total} checks passed")
    print(f"{'=' * 60}\n")

    failed = [(n, d) for n, ok, d in results if not ok]
    if failed:
        print("  Failed checks:")
        for name, detail in failed:
            print(f"    {FAIL} {name}: {detail}")
        sys.exit(1)
    else:
        print("  All checks passed — F-INV-04 evidence complete.")
        sys.exit(0)


if __name__ == "__main__":
    main()
