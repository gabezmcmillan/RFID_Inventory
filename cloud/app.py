"""
Cloud app for the warehouse: switch-warehouse.brasfieldgorrie.com

Two jobs, one small FastAPI process (App Service + Azure PostgreSQL):

  1. /sync/exchange -- the private API the warehouse .exe calls (outbound
     HTTPS from the warehouse PC; the cloud never calls into the .exe). Auth
     is a bearer token (SYNC_TOKEN env var), NOT Entra SSO -- exclude /sync/*
     from Easy Auth when enabling it (see README.md).
  2. The employee-facing site: a read-only inventory view and a "request
     materials" form. Requests queue in Postgres until the .exe's next sync.
     Sign-in is handled by App Service Easy Auth (Entra ID) in front of the
     app; the app itself stays auth-agnostic.

Run locally:
  DATABASE_URL=postgresql://postgres:postgres@localhost:5433/warehouse \
  SYNC_TOKEN=dev-token uvicorn app:app --port 8100   (from cloud/)
"""

import hmac
import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Body, FastAPI, Form, Header, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from db import CloudDatabase

# All endpoints are plain `def`: FastAPI runs them in its threadpool, so the
# blocking psycopg calls never sit on the event loop.

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SYNC_TOKEN = os.environ.get("SYNC_TOKEN", "")

templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))


class State:
    db: Optional[CloudDatabase] = None
    db_error: str = ""


state = State()


def get_db():
    """Lazy DB init so the app can boot before Postgres/firewall is ready."""
    if state.db is None:
        try:
            state.db = CloudDatabase()
            state.db_error = ""
        except Exception as exc:  # noqa: BLE001
            state.db_error = str(exc)
    return state.db


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_db()   # warm up (best effort; requests retry via get_db)
    yield
    if state.db:
        state.db.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")),
          name="static")


def _db_or_503():
    db = get_db()
    if db is None:
        return None, JSONResponse(
            {"ok": False, "message": f"Database unavailable: {state.db_error}"},
            status_code=503)
    return db, None


# ---------------------------------------------------------------------------
# Sync API (called by the warehouse .exe; bearer token, no SSO)
# ---------------------------------------------------------------------------
def _token_ok(authorization):
    if not SYNC_TOKEN:
        return False   # refuse to sync until the deployment sets a token
    expected = f"Bearer {SYNC_TOKEN}"
    return bool(authorization) and hmac.compare_digest(authorization, expected)


@app.post("/sync/exchange")
def sync_exchange(payload: dict = Body(...),
                  authorization: Optional[str] = Header(None)):
    if not _token_ok(authorization):
        return JSONResponse({"ok": False, "message": "Invalid sync token"},
                            status_code=401)
    db, err = _db_or_503()
    if err:
        return err
    try:
        ack = db.apply_exchange(payload)
    except Exception as exc:  # noqa: BLE001 -- report, don't 500 opaquely
        return JSONResponse({"ok": False, "message": f"Exchange failed: {exc}"},
                            status_code=500)
    return ack


@app.get("/healthz")
def healthz():
    db = get_db()
    return {"ok": db is not None,
            "db": "up" if db is not None else state.db_error}


# ---------------------------------------------------------------------------
# Site pages (Easy Auth / Entra in front when deployed)
# ---------------------------------------------------------------------------
def _last_synced(db):
    return db.meta_get("last_exchange_at", "")


@app.get("/")
def inventory_page(request: Request):
    db, err = _db_or_503()
    if err:
        return templates.TemplateResponse(request, "error.html", {
            "message": state.db_error}, status_code=503)
    return templates.TemplateResponse(request, "inventory.html", {
        "types": db.inventory_summary(),
        "counts": db.counts(),
        "last_synced": _last_synced(db),
        "active": "inventory",
    })


@app.get("/requests")
def requests_page(request: Request, ok: str = "", error: str = ""):
    db, err = _db_or_503()
    if err:
        return templates.TemplateResponse(request, "error.html", {
            "message": state.db_error}, status_code=503)
    return templates.TemplateResponse(request, "requests.html", {
        "requests": db.list_requests(),
        "item_types": db.item_types(),
        "counts": db.counts(),
        "last_synced": _last_synced(db),
        "submitted": ok,
        "error": error,
        "active": "requests",
    })


@app.post("/requests")
def submit_request(item_type: str = Form(""),
                   quantity: str = Form("1"),
                   building: str = Form(""),
                   jobsite: str = Form(""),
                   requester: str = Form(""),
                   contact: str = Form(""),
                   note: str = Form("")):
    """Plain form post from the site; redirects back with the outcome."""
    db, err = _db_or_503()
    if err:
        return err
    result = db.create_request(item_type, quantity, building, jobsite,
                               requester, contact, note)
    if result.get("ok"):
        return RedirectResponse(f"/requests?ok={result['request']['id']}",
                                status_code=303)
    return RedirectResponse(f"/requests?error={result.get('message', '')}",
                            status_code=303)


# ---------------------------------------------------------------------------
# JSON API (same data as the pages, for programmatic use)
# ---------------------------------------------------------------------------
class RequestBody(BaseModel):
    item_type: str
    quantity: int = 1
    building: str = ""
    jobsite: str = ""
    requester: str = ""
    contact: str = ""
    note: str = ""


@app.get("/api/inventory")
def api_inventory():
    db, err = _db_or_503()
    if err:
        return err
    return {"types": db.inventory_summary(), "counts": db.counts(),
            "last_synced": _last_synced(db)}


@app.get("/api/requests")
def api_requests():
    db, err = _db_or_503()
    if err:
        return err
    return {"requests": db.list_requests()}


@app.post("/api/requests")
def api_create_request(body: RequestBody):
    db, err = _db_or_503()
    if err:
        return err
    return db.create_request(body.item_type, body.quantity, body.building,
                             body.jobsite, body.requester, body.contact,
                             body.note)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0",
                port=int(os.environ.get("PORT", "8100")))
