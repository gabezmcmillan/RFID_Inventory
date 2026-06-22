"""
RFID inventory web app.

A single process that:
  - serves the browser UI (static/),
  - owns the serial reader via a background worker thread (reader.py),
  - reads/writes a local SQLite database (db.py),
  - pushes live scan events to the browser over a WebSocket.

Run:  python app.py     (or: uvicorn app:app --reload)
Then open http://127.0.0.1:8000
"""

import asyncio
import queue
from contextlib import asynccontextmanager
from typing import Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
import reader as reader_mod
from reader import ReaderWorker

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------
class AppState:
    def __init__(self):
        self.raw_events: "queue.Queue[dict]" = queue.Queue()
        self.worker: Optional[ReaderWorker] = None
        self.db = None
        self.db_error: Optional[str] = None
        self.clients: set[WebSocket] = set()

    def init_db(self):
        try:
            from db import Database
            self.db = Database()
            self.db_error = None
        except Exception as exc:  # noqa: BLE001
            self.db = None
            self.db_error = str(exc)


state = AppState()


# ---------------------------------------------------------------------------
# Lifespan: start worker + background event pump
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.get_running_loop()

    await loop.run_in_executor(None, state.init_db)

    state.worker = ReaderWorker(on_event=lambda e: state.raw_events.put(e))
    state.worker.start()

    pump = asyncio.create_task(_event_pump())
    try:
        yield
    finally:
        pump.cancel()
        if state.worker:
            state.worker.stop()
        if state.db:
            state.db.close()


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def no_cache(request, call_next):
    """Local single-user tool: never let the browser cache the UI or API so
    code/config changes always show up on reload."""
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


# ---------------------------------------------------------------------------
# WebSocket broadcast
# ---------------------------------------------------------------------------
async def broadcast(message: dict):
    dead = []
    for ws in list(state.clients):
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        state.clients.discard(ws)


# ---------------------------------------------------------------------------
# Background pump: drain worker events, write the DB, push to browser
# ---------------------------------------------------------------------------
async def _event_pump():
    loop = asyncio.get_running_loop()
    while True:
        event = await loop.run_in_executor(None, state.raw_events.get)
        try:
            await _handle_event(event)
        except Exception as exc:  # noqa: BLE001
            await broadcast({"type": "error", "message": f"Event error: {exc}"})


async def _handle_event(event: dict):
    loop = asyncio.get_running_loop()
    kind = event.get("event")

    if kind == "status":
        await broadcast({"type": "reader_status",
                         "connected": event.get("connected"),
                         "message": event.get("message")})
        return

    if kind == "live":
        await broadcast({"type": "live", "mode": event.get("mode"),
                         "epc": event.get("epc"), "distinct": event.get("distinct")})
        return

    if kind == "finder":
        await broadcast({"type": "finder", "epc": event.get("epc"),
                         "rssi": event.get("rssi")})
        return

    if state.db is None:
        await broadcast({"type": "error",
                         "message": f"Database not available: {state.db_error}"})
        return

    if kind == "checkin_batch":
        epcs = event.get("epcs", [])
        item_type = event.get("item_type")
        fields = event.get("fields", {})
        item_fields = event.get("item_fields", {})
        building = fields.get("building_number", "")
        po_number = fields.get("po_number", "")
        vendor = fields.get("vendor", "")
        result = await loop.run_in_executor(
            None, state.db.receive_shipment,
            epcs, item_type, building, po_number, vendor, item_fields)
        # Stay armed on this shipment so more units can be tagged in.
        await broadcast({"type": "checkin_result", **result})
        return

    if kind == "scan" and event.get("mode") == reader_mod.CHECKOUT:
        epc = event["epc"]
        result = await loop.run_in_executor(
            None, state.db.deliver_to_site, epc)
        await broadcast({"type": "checkout_result", **result})
        return

    if kind == "inventory":
        epcs = event.get("epcs", [])
        result = await loop.run_in_executor(None, state.db.record_inventory, epcs)
        await broadcast({"type": "inventory_result", **result})
        return


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------
class ModeRequest(BaseModel):
    mode: str
    item_type: Optional[str] = None
    fields: Optional[Dict[str, str]] = None
    target_epc: Optional[str] = None


@app.get("/api/config")
async def get_config():
    return {
        "item_types": config.ITEM_TYPES,
        "type_fields": config.TYPE_FIELDS,
        "power_min": config.READER_POWER_MIN_DBM,
        "power_max": config.READER_POWER_MAX_DBM,
    }


@app.get("/api/status")
async def get_status():
    return {
        "reader_connected": bool(state.worker and state.worker.connected),
        "db_connected": state.db is not None,
        "db_error": state.db_error,
        "mode": state.worker.mode if state.worker else reader_mod.IDLE,
        "check_power": state.worker.check_power if state.worker else config.CHECK_POWER_DBM,
    }


class PowerRequest(BaseModel):
    dbm: int


@app.post("/api/power")
async def set_power(req: PowerRequest):
    """Adjust the check-in/check-out reader output power (dBm), applied live."""
    if state.worker is None:
        return JSONResponse({"ok": False, "message": "Reader worker not ready"}, 503)
    applied = state.worker.set_check_power(req.dbm)
    return {"ok": True, "check_power": applied}


@app.get("/api/inventory")
async def get_inventory(group_by: str = "po"):
    """Nested warehouse view: item type -> groups (by PO# or Building#)."""
    if state.db is None:
        return JSONResponse({"ok": False, "message": "Database not available"}, 503)
    loop = asyncio.get_running_loop()
    if group_by not in ("po", "building"):
        group_by = "po"
    return await loop.run_in_executor(None, state.db.inventory_tree, group_by)


@app.get("/api/inventory/group")
async def get_inventory_group(item_type: str, value: str = "", group_by: str = "po"):
    """Individual tags within one (item_type, group) cell for drill-down."""
    if state.db is None:
        return JSONResponse({"ok": False, "message": "Database not available"}, 503)
    loop = asyncio.get_running_loop()
    if group_by not in ("po", "building"):
        group_by = "po"
    return await loop.run_in_executor(
        None, state.db.group_tags, item_type, group_by, value)


@app.post("/api/mode")
async def set_mode(req: ModeRequest):
    if state.worker is None:
        return JSONResponse({"ok": False, "message": "Reader worker not ready"}, 503)

    mode = req.mode
    if mode not in (reader_mod.IDLE, reader_mod.CHECKIN, reader_mod.CHECKOUT,
                    reader_mod.INVENTORY, reader_mod.FINDER):
        return JSONResponse({"ok": False, "message": f"Unknown mode: {mode}"}, 400)

    payload = None
    if mode == reader_mod.CHECKIN:
        if req.item_type not in config.ITEM_TYPES:
            return JSONResponse(
                {"ok": False, "message": "A valid item_type is required for check-in"},
                400)
        payload = {"item_type": req.item_type, "fields": req.fields or {}}
    elif mode == reader_mod.FINDER:
        if not req.target_epc:
            return JSONResponse(
                {"ok": False, "message": "A target_epc is required for finder"}, 400)
        payload = {"target_epc": req.target_epc.upper()}

    state.worker.set_mode(mode, payload)
    return {"ok": True, "mode": mode}


class CheckinItemRequest(BaseModel):
    fields: Optional[Dict[str, str]] = None


@app.post("/api/checkin_item")
async def set_checkin_item(req: CheckinItemRequest):
    """Set the per-unit fields (SKU, mfc date) for the next check-in tag."""
    if state.worker is None:
        return JSONResponse({"ok": False, "message": "Reader worker not ready"}, 503)
    state.worker.set_checkin_item_fields(req.fields or {})
    return {"ok": True}


class SimulateRequest(BaseModel):
    epcs: List[str]


@app.post("/api/simulate_scan")
async def simulate_scan(req: SimulateRequest):
    """Inject a fake scan for testing the UI without hardware."""
    if state.worker is None:
        return JSONResponse({"ok": False, "message": "Reader worker not ready"}, 503)
    state.worker.inject_scan(req.epcs)
    return {"ok": True}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    state.clients.add(ws)
    try:
        await ws.send_json({
            "type": "reader_status",
            "connected": bool(state.worker and state.worker.connected),
            "message": "Connected to server",
        })
        while True:
            await ws.receive_text()  # keep the connection open; ignore content
    except WebSocketDisconnect:
        pass
    finally:
        state.clients.discard(ws)


# ---------------------------------------------------------------------------
# Static UI (mounted last so /api and /ws take precedence)
# ---------------------------------------------------------------------------
@app.get("/")
async def index():
    return FileResponse("static/index.html")


app.mount("/", StaticFiles(directory="static"), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=config.HOST, port=config.PORT, reload=False)
