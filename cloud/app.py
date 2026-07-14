"""
Cloud app for the warehouse: switch-warehouse.brasfieldgorrie.com

Two jobs, one small FastAPI process (App Service + Azure PostgreSQL):

  1. /sync/exchange -- the private API the warehouse .exe calls (outbound
     HTTPS from the warehouse PC; the cloud never calls into the .exe). Auth
     is a bearer token (SYNC_TOKEN env var), NOT Entra SSO -- exclude /sync/*
     from Easy Auth when enabling it (see README.md).
  2. The employee-facing site: a browse-the-stock table with a shopping cart
     (pick rows, set quantities, check out with contact/jobsite/notes) plus
     an order-status page. Requests queue in Postgres until the .exe's next
     sync. Sign-in is handled by App Service Easy Auth (Entra ID) in front
     of the app; the app itself stays auth-agnostic (headers only prefill
     the checkout form).

Run locally:
  DATABASE_URL=postgresql://postgres:postgres@localhost:5433/warehouse \
  SYNC_TOKEN=dev-token uvicorn app:app --port 8100   (from cloud/)
"""

import base64
import binascii
import hmac
import json
import os
from contextlib import asynccontextmanager
from typing import List, Optional

from fastapi import Body, FastAPI, Header, Request
from fastapi.responses import JSONResponse
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


def _user_from_headers(request: Request):
    """Signed-in user per App Service Easy Auth, for prefilling checkout.
    Absent headers (local runs, auth not enabled yet) mean manual entry --
    the app stays auth-agnostic."""
    email = request.headers.get("x-ms-client-principal-name", "").strip()
    name = ""
    principal = request.headers.get("x-ms-client-principal", "")
    if principal:
        try:
            claims = json.loads(base64.b64decode(principal)).get("claims", [])
            name = next((c.get("val", "") for c in claims
                         if c.get("typ") == "name"), "")
        except (ValueError, binascii.Error):
            pass
    return {"name": name, "email": email}


@app.get("/")
def inventory_page(request: Request):
    db, err = _db_or_503()
    if err:
        return templates.TemplateResponse(request, "error.html", {
            "message": state.db_error}, status_code=503)
    return templates.TemplateResponse(request, "inventory.html", {
        "stock": db.stock_rows(),
        "buildings": db.buildings(),
        "counts": db.counts(),
        "last_synced": _last_synced(db),
        "user": _user_from_headers(request),
        "active": "inventory",
    })


@app.get("/requests")
def requests_page(request: Request, ok: str = ""):
    db, err = _db_or_503()
    if err:
        return templates.TemplateResponse(request, "error.html", {
            "message": state.db_error}, status_code=503)
    return templates.TemplateResponse(request, "requests.html", {
        "orders": db.list_orders(),
        "counts": db.counts(),
        "last_synced": _last_synced(db),
        "submitted": ok,
        "active": "requests",
    })


# ---------------------------------------------------------------------------
# JSON API (the cart UI plus programmatic use)
# ---------------------------------------------------------------------------
class RequestBody(BaseModel):
    item_type: str
    quantity: int = 1
    building: str = ""
    jobsite: str = ""
    requester: str = ""
    contact: str = ""
    note: str = ""


class CartLine(BaseModel):
    item_type: str
    building: str = ""     # the stock row's building ('' = unassigned)
    quantity: int = 1


class CartBody(BaseModel):
    requester: str = ""
    contact: str = ""
    jobsite: str = ""
    note: str = ""
    delivery_building: str = ""
    lines: List[CartLine] = []


@app.get("/api/inventory")
def api_inventory():
    db, err = _db_or_503()
    if err:
        return err
    return {"types": db.inventory_summary(), "counts": db.counts(),
            "last_synced": _last_synced(db)}


@app.get("/api/stock")
def api_stock():
    """Requestable stock rows for the cart UI (refresh + re-validation)."""
    db, err = _db_or_503()
    if err:
        return err
    return {"stock": db.stock_rows(), "buildings": db.buildings(),
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


@app.post("/api/requests/cart")
def api_create_cart(body: CartBody):
    """Submit a whole cart. Per-line availability errors come back with a 400
    so the UI can mark the offending lines."""
    db, err = _db_or_503()
    if err:
        return err
    result = db.create_cart_request(
        body.requester, body.contact, body.jobsite, body.note,
        body.delivery_building,
        [line.model_dump() for line in body.lines])
    if not result.get("ok"):
        return JSONResponse(result, status_code=400)
    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0",
                port=int(os.environ.get("PORT", "8100")))
