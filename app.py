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
import csv
import io
import os
import queue
import re
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import bol_extract
import config
import db as db_mod
import reader as reader_mod
import scanner
from reader import ReaderWorker
from sync import SyncWorker

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------
class AppState:
    def __init__(self):
        self.raw_events: "queue.Queue[dict]" = queue.Queue()
        self.worker: Optional[ReaderWorker] = None
        self.sync: Optional[SyncWorker] = None
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

    # One-time NAPS2 OCR language download, off the startup path (needs
    # network the first time; harmless no-op afterwards).
    loop.run_in_executor(None, scanner.ensure_ocr_component)

    state.worker = ReaderWorker(on_event=lambda e: state.raw_events.put(e))
    state.worker.start()

    # Cloud sync runs alongside the reader (needs the DB; no-op when
    # cloud_url isn't configured -- the app is fully usable offline).
    if state.db is not None:
        state.sync = SyncWorker(state.db,
                                on_event=lambda e: state.raw_events.put(e))
        state.sync.start()

    pump = asyncio.create_task(_event_pump())
    try:
        yield
    finally:
        pump.cancel()
        if state.worker:
            state.worker.stop()
        if state.sync:
            state.sync.stop()
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
                         "rssi": event.get("rssi"),
                         "percent": event.get("percent")})
        return

    if kind == "finder_reset":
        await broadcast({"type": "finder_reset"})
        return

    if kind == "sync_status":
        await broadcast({"type": "sync_status",
                         "enabled": event.get("enabled"),
                         "online": event.get("online"),
                         "last_sync": event.get("last_sync"),
                         "error": event.get("error"),
                         "pending": event.get("pending")})
        return

    if kind == "sync_requests":
        # New material requests arrived from the cloud on the last sync.
        await broadcast({"type": "requests_update",
                         "added": event.get("added", 0),
                         "pending": event.get("pending", 0)})
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
        bol_number = fields.get("bol_number", "")
        po_number = fields.get("po_number", "")
        vendor = fields.get("vendor", "")
        bol_doc_id = _as_doc_id(fields.get("bol_doc_id"))
        result = await loop.run_in_executor(
            None, state.db.receive_shipment,
            epcs, item_type, building, bol_number, vendor, item_fields,
            bol_doc_id, po_number)
        # Stay armed on this shipment so more units can be tagged in.
        await broadcast({"type": "checkin_result", **result})
        return

    if kind == "scan" and event.get("mode") == reader_mod.CHECKOUT:
        epc = event["epc"]
        # Two-step check-out: a trigger pull only looks the box up; the operator
        # then confirms how many units to draw down (see POST /api/checkout).
        result = await loop.run_in_executor(
            None, state.db.lookup_for_checkout, epc)
        await broadcast({"type": "checkout_prompt", **result})
        return

    if kind == "inventory":
        epcs = event.get("epcs", [])
        result = await loop.run_in_executor(None, state.db.record_inventory, epcs)
        # Include the burst's raw EPCs so the browser can accumulate a sweep
        # session across trigger pulls for the reconciliation view.
        await broadcast({"type": "inventory_result", "epcs": epcs, **result})
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
        "building_options": config.BUILDING_OPTIONS,
        "power_min": config.READER_POWER_MIN_DBM,
        "power_max": config.READER_POWER_MAX_DBM,
    }


@app.get("/api/status")
async def get_status():
    loop = asyncio.get_running_loop()
    requests_pending = 0
    if state.db is not None:
        requests_pending = await loop.run_in_executor(
            None, state.db.count_pending_requests)
    # status() recounts pending changes from the DB, so keep it off the loop.
    sync_status = (await loop.run_in_executor(None, state.sync.status)
                   if state.sync else {"enabled": False})
    return {
        "reader_connected": bool(state.worker and state.worker.connected),
        "db_connected": state.db is not None,
        "db_error": state.db_error,
        "mode": state.worker.mode if state.worker else reader_mod.IDLE,
        "check_power": state.worker.check_power if state.worker else config.CHECK_POWER_DBM,
        "sync": sync_status,
        "requests_pending": requests_pending,
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


def _as_doc_id(value):
    """Coerce a fields-dict bol_doc_id (string) to an int, or None."""
    try:
        doc_id = int(str(value).strip())
        return doc_id if doc_id > 0 else None
    except (TypeError, ValueError):
        return None


def _wh_filters(bol="", building="", received_from="", received_to="",
                checked_out_from="", checked_out_to=""):
    """Assemble the warehouse filter dict shared by the view and exports."""
    return {
        "bol": bol.strip(),
        "building": building.strip(),
        "received_from": received_from.strip(),
        "received_to": received_to.strip(),
        "checked_out_from": checked_out_from.strip(),
        "checked_out_to": checked_out_to.strip(),
    }


@app.get("/api/inventory")
async def get_inventory(group_by: str = "bol", bol: str = "", building: str = "",
                        received_from: str = "", received_to: str = "",
                        checked_out_from: str = "", checked_out_to: str = ""):
    """Nested warehouse view: item type -> groups (by BOL# or Building#)."""
    if state.db is None:
        return JSONResponse({"ok": False, "message": "Database not available"}, 503)
    loop = asyncio.get_running_loop()
    if group_by not in ("bol", "building"):
        group_by = "bol"
    filters = _wh_filters(bol, building, received_from, received_to,
                          checked_out_from, checked_out_to)
    return await loop.run_in_executor(
        None, state.db.inventory_tree, group_by, filters)


@app.get("/api/events")
async def get_events(filter: str = "all", epc: str = ""):
    """Audit-log feed for the Event Log view, filtered by category and/or EPC."""
    if state.db is None:
        return JSONResponse({"ok": False, "message": "Database not available"}, 503)
    if filter not in ("all", "checkin", "checkout", "scan"):
        filter = "all"
    loop = asyncio.get_running_loop()
    events = await loop.run_in_executor(
        None, state.db.list_events, filter, epc or None)
    return {"events": events}


@app.get("/api/vendors")
async def get_vendors():
    """Vendor dropdown options (managed in the Admin view)."""
    if state.db is None:
        return {"vendors": []}
    loop = asyncio.get_running_loop()
    vendors = await loop.run_in_executor(None, state.db.list_vendors)
    return {"vendors": vendors}


class VendorRequest(BaseModel):
    name: str


@app.post("/api/vendors")
async def add_vendor(req: VendorRequest):
    """Add a vendor from the check-in form (not PIN-gated: adding a missing
    vendor is a check-in-desk action; removal stays admin-only)."""
    bad = _require_db()
    if bad:
        return bad
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, state.db.add_vendor, req.name)


# ---------------------------------------------------------------------------
# Shipment notes
# ---------------------------------------------------------------------------
class NoteRequest(BaseModel):
    item_type: str
    bol_number: str = ""
    building: str = ""
    text: str


@app.get("/api/notes")
async def get_notes(item_type: str, bol_number: Optional[str] = None,
                    building: Optional[str] = None):
    """Notes for a shipment. Check-in passes the exact triple; a warehouse row
    passes just its grouped dimension. Omitted params don't filter."""
    bad = _require_db()
    if bad:
        return bad
    loop = asyncio.get_running_loop()
    notes = await loop.run_in_executor(
        None, state.db.list_notes, item_type, bol_number, building)
    return {"notes": notes}


@app.post("/api/notes")
async def add_note(req: NoteRequest):
    """Attach a note to a shipment (not PIN-gated, same trust as check-in)."""
    bad = _require_db()
    if bad:
        return bad
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, state.db.add_note, req.item_type, req.bol_number, req.building,
        req.text)


@app.get("/api/inventory/group")
async def get_inventory_group(item_type: str, value: str = "", group_by: str = "bol",
                              bol: str = "", building: str = "",
                              received_from: str = "", received_to: str = "",
                              checked_out_from: str = "", checked_out_to: str = ""):
    """Individual tags within one (item_type, group) cell for drill-down."""
    if state.db is None:
        return JSONResponse({"ok": False, "message": "Database not available"}, 503)
    loop = asyncio.get_running_loop()
    if group_by not in ("bol", "building"):
        group_by = "bol"
    filters = _wh_filters(bol, building, received_from, received_to,
                          checked_out_from, checked_out_to)
    return await loop.run_in_executor(
        None, state.db.group_tags, item_type, group_by, value, filters)


# Columns for the warehouse export (CSV + print/PDF): (header, tag-dict key).
EXPORT_COLUMNS = [
    ("EPC", "epc"),
    ("Item Type", "item_type"),
    ("BOL #", "bol_number"),
    ("PO #", "po_number"),
    ("Building #", "building"),
    ("Checked Out To", "checkout_building"),
    ("Vendor", "vendor"),
    ("SKU", "sku"),
    ("Mfc Date", "mfc_date"),
    ("Units Remaining", "remaining"),
    ("Units Total", "quantity"),
    ("Status", "status"),
    ("Received", "received_at"),
    ("Checked Out", "delivered_at"),
    ("Flag", "flag"),
]


@app.get("/api/inventory/export")
async def export_inventory(bol: str = "", building: str = "",
                           received_from: str = "", received_to: str = "",
                           checked_out_from: str = "", checked_out_to: str = ""):
    """Flat per-box rows for the print/PDF export, honoring the view filters."""
    if state.db is None:
        return JSONResponse({"ok": False, "message": "Database not available"}, 503)
    filters = _wh_filters(bol, building, received_from, received_to,
                          checked_out_from, checked_out_to)
    loop = asyncio.get_running_loop()
    rows = await loop.run_in_executor(None, state.db.export_rows, filters)
    return {"rows": rows, "columns": [c[0] for c in EXPORT_COLUMNS],
            "keys": [c[1] for c in EXPORT_COLUMNS]}


@app.get("/api/inventory/export.csv")
async def export_inventory_csv(bol: str = "", building: str = "",
                               received_from: str = "", received_to: str = "",
                               checked_out_from: str = "", checked_out_to: str = ""):
    """CSV download of the (filtered) warehouse inventory, one row per box."""
    if state.db is None:
        return JSONResponse({"ok": False, "message": "Database not available"}, 503)
    filters = _wh_filters(bol, building, received_from, received_to,
                          checked_out_from, checked_out_to)
    loop = asyncio.get_running_loop()
    rows = await loop.run_in_executor(None, state.db.export_rows, filters)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([c[0] for c in EXPORT_COLUMNS])
    for tag in rows:
        writer.writerow([tag.get(key, "") for _, key in EXPORT_COLUMNS])
    filename = f"inventory_{datetime.now().strftime('%Y-%m-%d_%H%M')}.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Material requests (pulled from the cloud) + cloud sync
# ---------------------------------------------------------------------------
class RequestHandleRequest(BaseModel):
    id: int
    status: str          # "staging" | "pending" (cancel) | "declined"
    note: str = ""


class RequestDraw(BaseModel):
    epc: str
    amount: Optional[int] = None
    building: Optional[str] = None


class RequestFulfillRequest(BaseModel):
    id: int
    draws: List[RequestDraw]
    note: str = ""


@app.get("/api/requests")
async def get_requests(status: str = ""):
    """Material requests for the Requests panel (open first, newest first)."""
    bad = _require_db()
    if bad:
        return bad
    loop = asyncio.get_running_loop()
    rows = await loop.run_in_executor(
        None, state.db.list_requests, status or None)
    pending = await loop.run_in_executor(None, state.db.count_pending_requests)
    return {"requests": rows, "pending": pending}


async def _broadcast_requests_update():
    pending = await asyncio.get_running_loop().run_in_executor(
        None, state.db.count_pending_requests)
    await broadcast({"type": "requests_update", "added": 0, "pending": pending})


@app.post("/api/requests/handle")
async def handle_request(req: RequestHandleRequest):
    """Move a request between pending/staging/declined (fulfilling goes
    through /api/requests/fulfill so inventory and status change together)."""
    bad = _require_db()
    if bad:
        return bad
    if req.status not in (db_mod.REQUEST_PENDING, db_mod.REQUEST_STAGING,
                          db_mod.REQUEST_DECLINED):
        return JSONResponse(
            {"ok": False, "message": f"Invalid request status: {req.status}"},
            400)
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None, state.db.set_request_status, req.id, req.status, req.note)
    if result.get("ok"):
        await _broadcast_requests_update()
        if state.sync:
            state.sync.sync_now()   # tell the requester ASAP
    return result


@app.post("/api/requests/fulfill")
async def fulfill_request(req: RequestFulfillRequest):
    """Confirm delivery: commit the staged draws and mark the request
    fulfilled in one transaction; the outcome is pushed on the next sync."""
    bad = _require_db()
    if bad:
        return bad
    draws = [d.model_dump() for d in req.draws]
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None, state.db.fulfill_request, req.id, draws, req.note)
    if result.get("ok"):
        await _broadcast_requests_update()
        if state.sync:
            state.sync.sync_now()
    return result


@app.post("/api/sync/now")
async def sync_now():
    """Manual 'Sync now' (the worker also runs on its own timer)."""
    if state.sync is None or not state.sync.enabled:
        return {"ok": False,
                "message": "Sync is off — set cloud_url in settings.ini"}
    state.sync.sync_now()
    return {"ok": True, "message": "Sync started"}


# ---------------------------------------------------------------------------
# Bill-of-lading documents (scan / upload / serve)
# ---------------------------------------------------------------------------
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


def _new_scan_filename(prefix="bol"):
    """Timestamped, collision-free filename inside SCANS_DIR."""
    base = datetime.now().strftime(f"{prefix}_%Y%m%d_%H%M%S")
    filename = f"{base}.pdf"
    n = 2
    while os.path.exists(os.path.join(config.SCANS_DIR, filename)):
        filename = f"{base}_{n}.pdf"
        n += 1
    return filename


def _default_bol_reference():
    """Placeholder BOL number until the operator renames it, e.g. 'BOL 07-07 3:12PM'."""
    now = datetime.now()
    hour = now.strftime("%I").lstrip("0") or "12"
    return f"BOL {now.strftime('%m-%d')} {hour}:{now.strftime('%M%p')}"


def _extract_bol_fields(path, ocr_if_needed=False):
    """OCR-text guesses for a BOL PDF (blocking; run in an executor).

    Returns {"bol_number", "po_number", "vendor", "ocr_text"} with "" for
    anything not found. With `ocr_if_needed` (uploads), a PDF with no text
    layer is first OCRed in place via NAPS2; scanned PDFs already got their
    text layer during the scan itself.
    """
    text = scanner.extract_pdf_text(path)
    if not text and ocr_if_needed and scanner.ocr_pdf(path):
        text = scanner.extract_pdf_text(path)
    vendors = state.db.list_vendors() if state.db else []
    fields = bol_extract.extract_fields(text, vendors)
    fields["ocr_text"] = text
    return fields


class BolScanRequest(BaseModel):
    append_to: Optional[int] = None


@app.post("/api/bol/scan")
async def bol_scan(req: BolScanRequest):
    """Feed a sheet through the document scanner.

    Without `append_to`: create a new BOL document (PDF + bol_docs row).
    With `append_to`: rescan into that document, appending the new page.
    """
    bad = _require_db()
    if bad:
        return bad
    loop = asyncio.get_running_loop()

    if req.append_to:
        doc = await loop.run_in_executor(None, state.db.get_bol_doc, req.append_to)
        if doc is None:
            return JSONResponse(
                {"ok": False, "message": "BOL document not found"}, 404)
        doc_id = doc["id"]
        path = os.path.join(config.SCANS_DIR, doc["filename"])
        try:
            await loop.run_in_executor(
                None, lambda: scanner.scan_to_pdf(path, append_from=path))
        except scanner.ScannerBusy as exc:
            return JSONResponse({"ok": False, "message": str(exc)}, 409)
        except scanner.ScanError as exc:
            return {"ok": False, "message": str(exc)}
        pages = await loop.run_in_executor(None, scanner.count_pdf_pages, path)
        await loop.run_in_executor(
            None, state.db.set_bol_doc_pages, doc_id, pages)
        # Re-run extraction over the full document: the new page may carry
        # the numbers the first page lacked. Only fills what the operator
        # hasn't set (see apply_bol_extraction).
        extracted = await loop.run_in_executor(None, _extract_bol_fields, path)
        doc = await loop.run_in_executor(
            None, lambda: state.db.apply_bol_extraction(
                doc_id, bol_number=extracted["bol_number"],
                vendor=extracted["vendor"], po_number=extracted["po_number"],
                ocr_text=extracted["ocr_text"]))
        return {"ok": True, "doc": doc, "appended": True}

    filename = _new_scan_filename()
    path = os.path.join(config.SCANS_DIR, filename)
    try:
        await loop.run_in_executor(None, scanner.scan_to_pdf, path)
    except scanner.ScannerBusy as exc:
        return JSONResponse({"ok": False, "message": str(exc)}, 409)
    except scanner.ScanError as exc:
        return {"ok": False, "message": str(exc)}
    pages = await loop.run_in_executor(None, scanner.count_pdf_pages, path)
    extracted = await loop.run_in_executor(None, _extract_bol_fields, path)
    reference = extracted["bol_number"] or _default_bol_reference()
    doc = await loop.run_in_executor(
        None, lambda: state.db.create_bol_doc(
            reference, filename, "scan", pages,
            vendor=extracted["vendor"], po_number=extracted["po_number"],
            ocr_text=extracted["ocr_text"]))
    return {"ok": True, "doc": doc}


@app.post("/api/bol/upload")
async def bol_upload(file: UploadFile = File(...)):
    """Fallback for when the scanner is unavailable: upload the BOL as a PDF."""
    bad = _require_db()
    if bad:
        return bad
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        return {"ok": False, "message": "That PDF is too large (25 MB max)."}
    if not data.startswith(b"%PDF-"):
        return {"ok": False, "message": "That file doesn't look like a PDF."}

    loop = asyncio.get_running_loop()
    filename = _new_scan_filename("bol_upload")
    path = os.path.join(config.SCANS_DIR, filename)

    def _write():
        os.makedirs(config.SCANS_DIR, exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)

    await loop.run_in_executor(None, _write)
    pages = await loop.run_in_executor(None, scanner.count_pdf_pages, path)
    # Vendor-generated PDFs usually have a text layer already; photos/scans
    # uploaded as PDF don't, so OCR those in place first (ocr_if_needed).
    extracted = await loop.run_in_executor(
        None, lambda: _extract_bol_fields(path, ocr_if_needed=True))
    # Reference preference: number read off the document, else the file's
    # name (often the BOL number), else a timestamp. Renameable regardless.
    stem = os.path.splitext(os.path.basename(file.filename or ""))[0].strip()
    reference = extracted["bol_number"] or stem or _default_bol_reference()
    doc = await loop.run_in_executor(
        None, lambda: state.db.create_bol_doc(
            reference, filename, "upload", pages,
            vendor=extracted["vendor"], po_number=extracted["po_number"],
            ocr_text=extracted["ocr_text"]))
    return {"ok": True, "doc": doc}


@app.get("/api/bol/docs")
async def bol_docs(limit: int = 15):
    """BOL documents, newest first. Default limit feeds the check-in
    'resume' list; `limit=0` returns everything (BOL Documents view)."""
    bad = _require_db()
    if bad:
        return bad
    limit = max(0, limit)
    loop = asyncio.get_running_loop()
    docs = await loop.run_in_executor(None, state.db.list_bol_docs, limit)
    return {"docs": docs}


class BolRenameRequest(BaseModel):
    id: int
    bol_number: str


@app.post("/api/bol/rename")
async def bol_rename(req: BolRenameRequest):
    """Set the document's real BOL number; already-checked-in tags follow."""
    bad = _require_db()
    if bad:
        return bad
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, state.db.rename_bol_doc, req.id, req.bol_number)


@app.get("/api/bol/{doc_id}/file")
async def bol_file(doc_id: int):
    """Serve the BOL PDF inline so the browser can display it."""
    bad = _require_db()
    if bad:
        return bad
    loop = asyncio.get_running_loop()
    doc = await loop.run_in_executor(None, state.db.get_bol_doc, doc_id)
    if doc is None:
        return JSONResponse({"ok": False, "message": "BOL document not found"}, 404)
    path = os.path.join(config.SCANS_DIR, doc["filename"])
    if not os.path.exists(path):
        return JSONResponse(
            {"ok": False, "message": f"PDF file missing on disk: {path}"}, 404)
    safe_name = re.sub(r"[^\w\- ]+", "_", doc["bol_number"]) or "bol"
    return FileResponse(path, media_type="application/pdf",
                        filename=f"{safe_name}.pdf",
                        content_disposition_type="inline")


@app.get("/api/scanner/status")
async def scanner_status():
    """Document-scanner health check (NAPS2 installed? ES-50 visible?)."""
    if not scanner.naps2_installed():
        return {"ok": False, "installed": False, "devices": [],
                "message": ("NAPS2 is not installed. Run: "
                            "brew install --cask naps2")}
    loop = asyncio.get_running_loop()
    try:
        devices = await loop.run_in_executor(None, scanner.list_devices)
    except scanner.ScanError as exc:
        return {"ok": False, "installed": True, "devices": [],
                "message": str(exc)}
    found = any(config.SCANNER_DEVICE.lower() in d.lower() for d in devices)
    message = ("Scanner ready." if found else
               (f"NAPS2 is installed but no '{config.SCANNER_DEVICE}' was "
                "found. Check USB and power."))
    return {"ok": found, "installed": True, "devices": devices,
            "device_found": found, "message": message}


# ---------------------------------------------------------------------------
# Admin (PIN-gated)
# ---------------------------------------------------------------------------
class AdminAuth(BaseModel):
    pin: Optional[str] = None


class AdminTagRequest(BaseModel):
    pin: Optional[str] = None
    epc: str
    fields: Optional[Dict[str, str]] = None


class AdminEpcRequest(BaseModel):
    pin: Optional[str] = None
    epc: str


def _check_pin(pin):
    """Return None if the PIN is valid, else a 403 JSONResponse."""
    if not pin or pin != config.ADMIN_PIN:
        return JSONResponse({"ok": False, "message": "Invalid admin PIN"}, 403)
    return None


def _require_db():
    if state.db is None:
        return JSONResponse({"ok": False, "message": "Database not available"}, 503)
    return None


@app.post("/api/admin/verify")
async def admin_verify(req: AdminAuth):
    bad = _check_pin(req.pin)
    if bad:
        return bad
    return {"ok": True}


@app.post("/api/admin/clear")
async def admin_clear(req: AdminAuth):
    bad = _check_pin(req.pin) or _require_db()
    if bad:
        return bad
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, state.db.clear_all)
    return result


@app.post("/api/admin/tag")
async def admin_update_tag(req: AdminTagRequest):
    bad = _check_pin(req.pin) or _require_db()
    if bad:
        return bad
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, state.db.update_tag, req.epc, req.fields or {})


@app.post("/api/admin/tag/clear_flag")
async def admin_clear_flag(req: AdminEpcRequest):
    bad = _check_pin(req.pin) or _require_db()
    if bad:
        return bad
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, state.db.clear_flag, req.epc)


class AdminNoteDeleteRequest(BaseModel):
    pin: Optional[str] = None
    id: int


@app.post("/api/admin/note/delete")
async def admin_delete_note(req: AdminNoteDeleteRequest):
    """Remove a shipment note (typo fix, admin edit mode only)."""
    bad = _check_pin(req.pin) or _require_db()
    if bad:
        return bad
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, state.db.delete_note, req.id)


class AdminBolDeleteRequest(BaseModel):
    pin: Optional[str] = None
    id: int


@app.post("/api/admin/bol/delete")
async def admin_delete_bol(req: AdminBolDeleteRequest):
    """Delete a BOL document (row + PDF); boxes under it are only unlinked."""
    bad = _check_pin(req.pin) or _require_db()
    if bad:
        return bad
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, state.db.delete_bol_doc, req.id)


class AdminGroupDeleteRequest(BaseModel):
    pin: Optional[str] = None
    item_type: str
    group_by: str = "bol"
    value: str = ""


@app.post("/api/admin/group/delete")
async def admin_delete_group(req: AdminGroupDeleteRequest):
    """Delete every tag in one (item_type, group) warehouse cell."""
    bad = _check_pin(req.pin) or _require_db()
    if bad:
        return bad
    group_by = req.group_by if req.group_by in ("bol", "building") else "bol"
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, state.db.delete_group, req.item_type, group_by, req.value)


class AdminVendorRequest(BaseModel):
    pin: Optional[str] = None
    name: str


@app.post("/api/admin/vendor")
async def admin_add_vendor(req: AdminVendorRequest):
    bad = _check_pin(req.pin) or _require_db()
    if bad:
        return bad
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, state.db.add_vendor, req.name)


@app.post("/api/admin/vendor/remove")
async def admin_remove_vendor(req: AdminVendorRequest):
    bad = _check_pin(req.pin) or _require_db()
    if bad:
        return bad
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, state.db.remove_vendor, req.name)


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


@app.post("/api/alert")
async def fire_alert():
    """Fire a one-shot handheld alert (used by the finder on tag lock)."""
    if state.worker is None:
        return JSONResponse({"ok": False, "message": "Reader worker not ready"}, 503)
    state.worker.alert()
    return {"ok": True}


class CheckinItemRequest(BaseModel):
    fields: Optional[Dict[str, str]] = None


@app.post("/api/checkin_item")
async def set_checkin_item(req: CheckinItemRequest):
    """Set the per-unit fields (SKU, mfc date) for the next check-in tag."""
    if state.worker is None:
        return JSONResponse({"ok": False, "message": "Reader worker not ready"}, 503)
    state.worker.set_checkin_item_fields(req.fields or {})
    return {"ok": True}


class CheckinAmendRequest(BaseModel):
    epc: str
    fields: Optional[Dict[str, str]] = None


@app.post("/api/checkin/amend")
async def checkin_amend(req: CheckinAmendRequest):
    """Operator fix of the tag that was just checked in (SKU / mfc date / qty).

    Not PIN-gated: it only touches the per-unit fields and is meant for
    correcting a typo immediately after the trigger pull.
    """
    if state.db is None:
        return JSONResponse({"ok": False, "message": "Database not available"}, 503)
    allowed = {k: v for k, v in (req.fields or {}).items()
               if k in ("sku", "mfc_date", "quantity")}
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, state.db.amend_checkin, req.epc, allowed)


class CheckoutRequest(BaseModel):
    epc: str
    amount: Optional[int] = None
    building: Optional[str] = None


class CompareRequest(BaseModel):
    epcs: List[str]


@app.post("/api/inventory/compare")
async def compare_inventory(req: CompareRequest):
    """Reconcile the accumulated sweep-session EPCs against expected inventory."""
    if state.db is None:
        return JSONResponse({"ok": False, "message": "Database not available"}, 503)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, state.db.compare_inventory, req.epcs)


@app.get("/api/checkout/lookup")
async def checkout_lookup(epc: str):
    """Look a box up for the checkout confirm card (used by the warehouse
    view's Check Out button, which skips the trigger-pull lookup)."""
    if state.db is None:
        return JSONResponse({"ok": False, "message": "Database not available"}, 503)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, state.db.lookup_for_checkout, epc)


@app.post("/api/checkout")
async def checkout(req: CheckoutRequest):
    """Commit a check-out: draw `amount` units (None = whole box) out of a box."""
    if state.db is None:
        return JSONResponse({"ok": False, "message": "Database not available"}, 503)
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None, state.db.deliver_units, req.epc, req.amount, req.building)
    return result


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
            "server_greeting": True,
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
    return FileResponse(os.path.join(config.STATIC_DIR, "index.html"))


app.mount("/", StaticFiles(directory=config.STATIC_DIR), name="static")


if __name__ == "__main__":
    import threading
    import webbrowser

    import uvicorn

    if config.FROZEN:
        # Double-clicked .exe: pop the UI open once the server is up. (From
        # source, developers open/reload the browser themselves.)
        threading.Timer(
            1.5, webbrowser.open, args=(f"http://{config.HOST}:{config.PORT}",)
        ).start()
    # Pass the app object, not the "app:app" import string: a frozen bundle
    # can't re-import this module by name.
    uvicorn.run(app, host=config.HOST, port=config.PORT)
