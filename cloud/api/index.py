"""
RFID Inventory — cloud sync API (Vercel Python / FastAPI).

This is the offline-first sync target for the desktop app. Each device keeps a
local SQLite DB (see ../../db.py) and periodically pushes queued changes here and
pulls back anything newer from other devices. The cloud is the source of truth.

Design notes
  - Two synced tables mirror the local schema: `tags` (canonical inventory, keyed
    by the globally-unique EPC) and `events` (append-only audit log).
  - Conflict handling is last-write-wins on `tags.updated_at` (ISO-8601 strings
    sort correctly), and idempotent insert-by-`event_uid` for `events`. Because
    every write is keyed on a stable id, retries after a dropped connection are
    safe — the whole point of offline-first sync.
  - Auth is a per-device shared key in the `X-API-Key` header. Fine for a
    warehouse tool; swap for real identity later if IT requires it.

Endpoints
  GET  /                     liveness
  GET  /api/health           liveness + DB connectivity
  POST /api/sync/push        batch upsert tags + events   (device key)
  GET  /api/sync/pull        tags changed since a cursor  (device key)
  GET  /api/tags             list tags (dashboard/debug)  (device key)
  GET  /api/inventory        aggregated counts            (device key)
  POST /api/admin/init-db    create/upgrade schema        (admin key)
"""

import os
from datetime import datetime, timezone
from typing import Optional

import psycopg
from psycopg.rows import dict_row
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, Field

app = FastAPI(title="RFID Inventory Sync API", version="1.0.0")


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
def _dsn() -> str:
    # Neon (via the Vercel integration) provisions POSTGRES_URL. Fall back to the
    # common alternatives so this also runs against a plain DATABASE_URL locally.
    for key in ("POSTGRES_URL", "DATABASE_URL", "POSTGRES_PRISMA_URL"):
        val = os.environ.get(key)
        if val:
            return val
    raise RuntimeError("No Postgres connection string set (POSTGRES_URL).")


def connect() -> psycopg.Connection:
    # One short-lived connection per request; Neon's pooler handles concurrency,
    # which is the right pattern for serverless functions.
    return psycopg.connect(_dsn(), row_factory=dict_row, autocommit=False)


SCHEMA = """
CREATE TABLE IF NOT EXISTS tags (
    epc               TEXT PRIMARY KEY,
    item_type         TEXT NOT NULL DEFAULT '',
    bol_number        TEXT NOT NULL DEFAULT '',
    po_number         TEXT NOT NULL DEFAULT '',
    building          TEXT NOT NULL DEFAULT '',
    vendor            TEXT NOT NULL DEFAULT '',
    sku               TEXT NOT NULL DEFAULT '',
    mfc_date          TEXT NOT NULL DEFAULT '',
    quantity          INTEGER NOT NULL DEFAULT 1,
    remaining         INTEGER NOT NULL DEFAULT 1,
    status            TEXT NOT NULL DEFAULT 'In Warehouse',
    received_at       TEXT NOT NULL DEFAULT '',
    delivered_at      TEXT NOT NULL DEFAULT '',
    checkout_building TEXT NOT NULL DEFAULT '',
    flag              TEXT NOT NULL DEFAULT '',
    flagged_at        TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL DEFAULT '',
    updated_at        TEXT NOT NULL DEFAULT '',
    device_id         TEXT NOT NULL DEFAULT '',
    synced_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tags_status     ON tags (status);
CREATE INDEX IF NOT EXISTS idx_tags_updated_at ON tags (updated_at);
CREATE INDEX IF NOT EXISTS idx_tags_group      ON tags (item_type, bol_number, building);

CREATE TABLE IF NOT EXISTS events (
    event_uid  TEXT PRIMARY KEY,
    device_id  TEXT NOT NULL DEFAULT '',
    ts         TEXT NOT NULL DEFAULT '',
    action     TEXT NOT NULL DEFAULT '',
    epc        TEXT,
    item_type  TEXT,
    bol_number TEXT,
    building   TEXT,
    vendor     TEXT,
    detail     TEXT,
    synced_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_epc    ON events (epc);
CREATE INDEX IF NOT EXISTS idx_events_action ON events (action);
CREATE INDEX IF NOT EXISTS idx_events_ts     ON events (ts);

CREATE TABLE IF NOT EXISTS devices (
    device_id  TEXT PRIMARY KEY,
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_push  INTEGER NOT NULL DEFAULT 0
);
"""


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def _keys(env_name: str) -> set[str]:
    raw = os.environ.get(env_name, "")
    return {k.strip() for k in raw.split(",") if k.strip()}


def require_device(x_api_key: Optional[str] = Header(default=None)) -> str:
    valid = _keys("SYNC_API_KEYS")
    if not valid:
        raise HTTPException(503, "Server missing SYNC_API_KEYS configuration.")
    if not x_api_key or x_api_key not in valid:
        raise HTTPException(401, "Invalid or missing X-API-Key.")
    return x_api_key


def require_admin(x_api_key: Optional[str] = Header(default=None)) -> str:
    valid = _keys("ADMIN_API_KEY")
    if not valid:
        raise HTTPException(503, "Server missing ADMIN_API_KEY configuration.")
    if not x_api_key or x_api_key not in valid:
        raise HTTPException(401, "Invalid or missing admin X-API-Key.")
    return x_api_key


# ---------------------------------------------------------------------------
# Payload models
# ---------------------------------------------------------------------------
class TagIn(BaseModel):
    epc: str
    item_type: str = ""
    bol_number: str = ""
    po_number: str = ""
    building: str = ""
    vendor: str = ""
    sku: str = ""
    mfc_date: str = ""
    quantity: int = 1
    remaining: int = 1
    status: str = "In Warehouse"
    received_at: str = ""
    delivered_at: str = ""
    checkout_building: str = ""
    flag: str = ""
    flagged_at: str = ""
    created_at: str = ""
    updated_at: str = ""


class EventIn(BaseModel):
    # Client-generated stable id so re-sending after a dropped connection is a
    # no-op. A UUID or "<device_id>:<local_rowid>" both work.
    event_uid: str
    ts: str = ""
    action: str = ""
    epc: Optional[str] = None
    item_type: Optional[str] = None
    bol_number: Optional[str] = None
    building: Optional[str] = None
    vendor: Optional[str] = None
    detail: Optional[str] = None


class PushRequest(BaseModel):
    device_id: str = Field(..., min_length=1)
    tags: list[TagIn] = []
    events: list[EventIn] = []


_TAG_COLS = [
    "epc", "item_type", "bol_number", "po_number", "building", "vendor", "sku",
    "mfc_date", "quantity", "remaining", "status", "received_at", "delivered_at",
    "checkout_building", "flag", "flagged_at", "created_at", "updated_at",
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/")
def root():
    return {"service": "rfid-inventory-sync", "status": "ok", "time": _now_iso()}


@app.get("/api/health")
def health():
    try:
        with connect() as conn:
            conn.execute("SELECT 1")
        db_ok = True
    except Exception as exc:  # surface the reason without leaking secrets
        return {"status": "degraded", "db": False, "error": str(exc)[:200], "time": _now_iso()}
    return {"status": "ok", "db": db_ok, "time": _now_iso()}


@app.post("/api/sync/push")
def sync_push(body: PushRequest, _key: str = Depends(require_device)):
    now = _now_iso()
    tags_written = 0
    events_written = 0

    upsert_tag = f"""
        INSERT INTO tags ({", ".join(_TAG_COLS)}, device_id, synced_at)
        VALUES ({", ".join("%(" + c + ")s" for c in _TAG_COLS)}, %(device_id)s, now())
        ON CONFLICT (epc) DO UPDATE SET
            {", ".join(f"{c} = EXCLUDED.{c}" for c in _TAG_COLS if c != "epc")},
            device_id = EXCLUDED.device_id,
            synced_at = now()
        WHERE EXCLUDED.updated_at >= tags.updated_at
    """

    insert_event = """
        INSERT INTO events
            (event_uid, device_id, ts, action, epc, item_type, bol_number,
             building, vendor, detail)
        VALUES
            (%(event_uid)s, %(device_id)s, %(ts)s, %(action)s, %(epc)s,
             %(item_type)s, %(bol_number)s, %(building)s, %(vendor)s, %(detail)s)
        ON CONFLICT (event_uid) DO NOTHING
    """

    with connect() as conn:
        with conn.cursor() as cur:
            for tag in body.tags:
                params = tag.model_dump()
                params["device_id"] = body.device_id
                if not params.get("updated_at"):
                    params["updated_at"] = now
                cur.execute(upsert_tag, params)
                tags_written += cur.rowcount

            for ev in body.events:
                params = ev.model_dump()
                params["device_id"] = body.device_id
                cur.execute(insert_event, params)
                events_written += cur.rowcount

            cur.execute(
                """
                INSERT INTO devices (device_id, last_seen, last_push)
                VALUES (%s, now(), %s)
                ON CONFLICT (device_id)
                DO UPDATE SET last_seen = now(), last_push = EXCLUDED.last_push
                """,
                (body.device_id, len(body.tags)),
            )
        conn.commit()

    return {
        "ok": True,
        "server_time": now,
        "tags_received": len(body.tags),
        "tags_written": tags_written,
        "events_received": len(body.events),
        "events_written": events_written,
    }


@app.get("/api/sync/pull")
def sync_pull(
    since: Optional[str] = Query(default=None, description="ISO-8601 cursor; return tags with updated_at > since"),
    limit: int = Query(default=1000, ge=1, le=5000),
    _key: str = Depends(require_device),
):
    now = _now_iso()
    with connect() as conn:
        if since:
            rows = conn.execute(
                "SELECT * FROM tags WHERE updated_at > %s ORDER BY updated_at ASC LIMIT %s",
                (since, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM tags ORDER BY updated_at ASC LIMIT %s", (limit,)
            ).fetchall()
    for r in rows:
        if isinstance(r.get("synced_at"), datetime):
            r["synced_at"] = r["synced_at"].isoformat()
    cursor = rows[-1]["updated_at"] if rows else since
    return {"server_time": now, "count": len(rows), "next_cursor": cursor, "tags": rows}


@app.get("/api/tags")
def list_tags(
    status: Optional[str] = Query(default=None),
    limit: int = Query(default=200, ge=1, le=2000),
    _key: str = Depends(require_device),
):
    with connect() as conn:
        if status:
            rows = conn.execute(
                "SELECT * FROM tags WHERE status = %s ORDER BY updated_at DESC LIMIT %s",
                (status, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM tags ORDER BY updated_at DESC LIMIT %s", (limit,)
            ).fetchall()
    for r in rows:
        if isinstance(r.get("synced_at"), datetime):
            r["synced_at"] = r["synced_at"].isoformat()
    return {"count": len(rows), "tags": rows}


@app.get("/api/inventory")
def inventory(_key: str = Depends(require_device)):
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT item_type, status,
                   COUNT(*)              AS tag_count,
                   COALESCE(SUM(remaining), 0) AS remaining
            FROM tags
            GROUP BY item_type, status
            ORDER BY item_type, status
            """
        ).fetchall()
    return {"count": len(rows), "rows": rows}


@app.post("/api/admin/init-db")
def init_db(_key: str = Depends(require_admin)):
    with connect() as conn:
        conn.execute(SCHEMA)
        conn.commit()
    return {"ok": True, "message": "Schema created/verified.", "time": _now_iso()}
