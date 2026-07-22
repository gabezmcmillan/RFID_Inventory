"""
SQLite backend for the RFID inventory web app (shipment model, local store).

This replaces the Google Sheets backend. The `tags` table is the single source
of truth: one row per physical EPC. A "shipment" / warehouse-inventory row is a
derived aggregation over tags grouped by (item_type, bol_number, building), so
quantities are always a COUNT and can never drift out of sync.

Tables (created on first run):
  tags       EPC -> item_type, BOL#, Building#, Sector, Vendor, Item No. (sku),
             mfc date, status, received_at, delivered_at. One row per tag.
  events     Append-only audit log (IN / OUT / COUNT / ...).
  requests   Material requests pulled from the cloud app (cloud id == local id)
             plus the manager's handling status.
  sync_state Key/value watermarks for the cloud sync worker (sync.py).

A tag (box) can hold multiple units: `quantity` is the units it arrived with and
`remaining` is the units left in it now. Group/item quantities are SUM(remaining)
so they stay a derived total that can never drift. Check-out is two-step: look the
box up, then draw down a chosen number of units (the whole box by default).

Public API:
  receive_shipment(epcs, item_type, building, bol_number, vendor, item_fields)
  lookup_for_checkout(epc) / deliver_units(epc, amount)
  record_inventory(epcs)
Plus read helpers for the interactive inventory view and finder:
  inventory_tree(group_by), group_tags(item_type, group_by, value), find_tag(epc)
"""

import json
import os
import sqlite3
import threading
from datetime import datetime

import config
from contract import sync_contract

STATUS_IN = "In Warehouse"
STATUS_DELIVERED = "Delivered"
STATUS_PARTIAL = "Partial"

# Material-request lifecycle (rows are created by the cloud app; the manager
# resolves them here). staging = the manager is scanning boxes for it in the
# checkout screen; fulfilled is only reachable through fulfill_request().
REQUEST_PENDING = "pending"
REQUEST_STAGING = "staging"
REQUEST_FULFILLED = "fulfilled"
REQUEST_DECLINED = "declined"
REQUEST_STATUSES = (REQUEST_PENDING, REQUEST_STAGING, REQUEST_FULFILLED,
                    REQUEST_DECLINED)

# group_by accepts these UI dimensions, mapped to tag columns.
GROUP_COLUMNS = {"bol": "bol_number", "building": "building"}


def _as_quantity(value, default=1):
    """Coerce a user-supplied quantity to a positive int (>= 1)."""
    try:
        n = int(float(str(value).strip()))
    except (TypeError, ValueError, AttributeError):
        return default
    return n if n >= 1 else default


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _today():
    return datetime.now().strftime("%m/%d/%Y")


def _date_of(iso_ts):
    """Format an ISO timestamp as mm/dd/yyyy for display (best effort)."""
    try:
        return datetime.fromisoformat(iso_ts).strftime("%m/%d/%Y")
    except (TypeError, ValueError):
        return iso_ts or ""


def _datetime_of(iso_ts):
    """Format an ISO timestamp as mm/dd/yyyy h:mm AM/PM (best effort)."""
    try:
        return datetime.fromisoformat(iso_ts).strftime("%m/%d/%Y %I:%M %p")
    except (TypeError, ValueError):
        return iso_ts or ""


class Database:
    def __init__(self, path=None):
        self.path = path or config.DB_PATH
        # check_same_thread=False because app.py calls these from executor
        # threads; a single lock serializes all access (single-user tool).
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._create_schema()

    # -- setup ---------------------------------------------------------------
    def _create_schema(self):
        with self._lock:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS tags (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    epc          TEXT UNIQUE NOT NULL,
                    item_type    TEXT NOT NULL,
                    item_name    TEXT NOT NULL DEFAULT '',
                    bol_number    TEXT NOT NULL DEFAULT '',
                    po_number    TEXT NOT NULL DEFAULT '',
                    building     TEXT NOT NULL DEFAULT '',
                    sector       TEXT NOT NULL DEFAULT '',
                    vendor       TEXT NOT NULL DEFAULT '',
                    sku          TEXT NOT NULL DEFAULT '',
                    mfc_date     TEXT NOT NULL DEFAULT '',
                    quantity     INTEGER NOT NULL DEFAULT 1,
                    remaining    INTEGER NOT NULL DEFAULT 1,
                    status       TEXT NOT NULL DEFAULT 'In Warehouse',
                    received_at  TEXT NOT NULL,
                    delivered_at TEXT NOT NULL DEFAULT '',
                    checkout_building TEXT NOT NULL DEFAULT '',
                    flag         TEXT NOT NULL DEFAULT '',
                    flagged_at   TEXT NOT NULL DEFAULT '',
                    created_at   TEXT NOT NULL,
                    updated_at   TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS events (
                    id        INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts        TEXT NOT NULL,
                    action    TEXT NOT NULL,
                    epc       TEXT,
                    item_type TEXT,
                    bol_number TEXT,
                    building  TEXT,
                    vendor    TEXT,
                    detail    TEXT
                );
                CREATE TABLE IF NOT EXISTS vendors (
                    name TEXT PRIMARY KEY
                );
                CREATE TABLE IF NOT EXISTS bol_docs (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    bol_number TEXT NOT NULL,
                    filename   TEXT NOT NULL,
                    source     TEXT NOT NULL DEFAULT 'scan',
                    pages      INTEGER NOT NULL DEFAULT 1,
                    vendor     TEXT NOT NULL DEFAULT '',
                    po_number  TEXT NOT NULL DEFAULT '',
                    ocr_text   TEXT NOT NULL DEFAULT '',
                    -- Goods lines parsed off the document (JSON array of
                    -- {item_no, item_name}); check-in offers them as
                    -- one-tap prefills. Local-only, like ocr_text.
                    line_items TEXT NOT NULL DEFAULT '[]',
                    auto_named INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS notes (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts         TEXT NOT NULL,
                    item_type  TEXT NOT NULL,
                    bol_number TEXT NOT NULL DEFAULT '',
                    building   TEXT NOT NULL DEFAULT '',
                    text       TEXT NOT NULL
                );
                -- Material requests pulled from the cloud. The cloud owns
                -- creation, so its serial id is used as the local primary key
                -- (making re-pulls idempotent). status_dirty marks rows whose
                -- handling (fulfilled/declined) still has to be pushed back.
                CREATE TABLE IF NOT EXISTS requests (
                    id           INTEGER PRIMARY KEY,
                    item_type    TEXT NOT NULL,
                    item_name    TEXT NOT NULL DEFAULT '',
                    quantity     INTEGER NOT NULL DEFAULT 1,
                    building     TEXT NOT NULL DEFAULT '',
                    jobsite      TEXT NOT NULL DEFAULT '',
                    requester    TEXT NOT NULL DEFAULT '',
                    contact      TEXT NOT NULL DEFAULT '',
                    note         TEXT NOT NULL DEFAULT '',
                    status       TEXT NOT NULL DEFAULT 'pending',
                    created_at   TEXT NOT NULL DEFAULT '',
                    handled_at   TEXT NOT NULL DEFAULT '',
                    handler_note TEXT NOT NULL DEFAULT '',
                    status_dirty INTEGER NOT NULL DEFAULT 0,
                    -- Lines submitted together as one cart order share a ref.
                    order_ref    TEXT NOT NULL DEFAULT ''
                );
                -- Sync watermarks / bookkeeping for sync.py (key/value).
                CREATE TABLE IF NOT EXISTS sync_state (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_notes_group
                    ON notes (item_type, bol_number, building);
                CREATE INDEX IF NOT EXISTS idx_tags_group
                    ON tags (item_type, bol_number, building);
                CREATE INDEX IF NOT EXISTS idx_tags_status ON tags (status);
                CREATE INDEX IF NOT EXISTS idx_events_action ON events (action);
                CREATE INDEX IF NOT EXISTS idx_events_epc ON events (epc);
                """
            )
            self._migrate()
            self._seed_vendors()
            self._conn.commit()

    def _seed_vendors(self):
        """Populate the vendor list from config on first run (empty table only)."""
        have = self._conn.execute("SELECT COUNT(*) AS n FROM vendors").fetchone()["n"]
        if have:
            return
        for name in getattr(config, "DEFAULT_VENDORS", []):
            name = (name or "").strip()
            if name:
                self._conn.execute(
                    "INSERT OR IGNORE INTO vendors (name) VALUES (?)", (name,))

    def _migrate(self):
        """Add columns to an existing `tags` table created by an older schema."""
        # PO Number was renamed to BOL Number (Bill of Lading); rename the old
        # column in place so existing data carries over.
        for table in ("tags", "events"):
            cols = {row["name"] for row in
                    self._conn.execute(f"PRAGMA table_info({table})").fetchall()}
            if "po_number" in cols and "bol_number" not in cols:
                self._conn.execute(
                    f"ALTER TABLE {table} RENAME COLUMN po_number TO bol_number")
        have = {row["name"] for row in
                self._conn.execute("PRAGMA table_info(tags)").fetchall()}
        for col in ("flag", "flagged_at", "checkout_building", "po_number",
                    "sector", "item_name"):
            if col not in have:
                self._conn.execute(
                    f"ALTER TABLE tags ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        # OCR metadata on BOL documents: extracted vendor/PO guesses, the raw
        # text layer (debugging/search), and whether the doc's BOL number is
        # still machine-generated (auto_named=1) vs. operator-confirmed.
        have_docs = {row["name"] for row in
                     self._conn.execute("PRAGMA table_info(bol_docs)").fetchall()}
        for col in ("vendor", "po_number", "ocr_text"):
            if col not in have_docs:
                self._conn.execute(
                    f"ALTER TABLE bol_docs ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        # Goods lines parsed off the document (JSON [{item_no, item_name}]).
        if "line_items" not in have_docs:
            self._conn.execute(
                "ALTER TABLE bol_docs ADD COLUMN line_items "
                "TEXT NOT NULL DEFAULT '[]'")
        if "auto_named" not in have_docs:
            self._conn.execute(
                "ALTER TABLE bol_docs ADD COLUMN auto_named INTEGER NOT NULL DEFAULT 1")
        # Link to the scanned bill-of-lading document (bol_docs row). Nullable:
        # legacy rows and manual check-ins have no document.
        if "bol_doc_id" not in have:
            self._conn.execute("ALTER TABLE tags ADD COLUMN bol_doc_id INTEGER")
        # Cart orders on the cloud site: lines of one order share an order_ref.
        have_req = {row["name"] for row in
                    self._conn.execute("PRAGMA table_info(requests)").fetchall()}
        if "order_ref" not in have_req:
            self._conn.execute(
                "ALTER TABLE requests ADD COLUMN order_ref TEXT NOT NULL DEFAULT ''")
        # Component name on a request (W.I.F. accessories are requested per
        # component, not as one pooled type).
        if "item_name" not in have_req:
            self._conn.execute(
                "ALTER TABLE requests ADD COLUMN item_name TEXT NOT NULL DEFAULT ''")
        # Multi-unit columns: a tag (box) can represent N units. Older rows were
        # one-unit-per-tag, so they default to quantity = remaining = 1, except
        # already-delivered boxes which have nothing left (remaining = 0).
        if "quantity" not in have:
            self._conn.execute(
                "ALTER TABLE tags ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1")
        if "remaining" not in have:
            self._conn.execute(
                "ALTER TABLE tags ADD COLUMN remaining INTEGER NOT NULL DEFAULT 1")
            self._conn.execute(
                f"UPDATE tags SET remaining = 0 WHERE status = '{STATUS_DELIVERED}'")
        # Backfill checkout dates for boxes that were (partially) checked out
        # before delivered_at was recorded on every draw. Use the latest OUT
        # event time. Idempotent: only fills rows still missing a date that have
        # actually had units drawn (remaining < quantity skips untouched boxes).
        self._conn.execute(
            """
            UPDATE tags
            SET delivered_at = (
                SELECT MAX(e.ts) FROM events e
                WHERE e.action = 'OUT' AND e.epc = tags.epc
            )
            WHERE delivered_at = ''
              AND remaining < quantity
              AND EXISTS (
                SELECT 1 FROM events e
                WHERE e.action = 'OUT' AND e.epc = tags.epc
              )
            """
        )

    # -- internals -----------------------------------------------------------
    def _log(self, action, epc, item_type="", bol_number="", building="",
             vendor="", detail=""):
        self._conn.execute(
            "INSERT INTO events (ts, action, epc, item_type, bol_number, "
            "building, vendor, detail) VALUES (?,?,?,?,?,?,?,?)",
            (_now(), action, epc, item_type, bol_number, building, vendor, detail),
        )

    def _group_in_warehouse_qty(self, item_type, bol_number, building):
        """Units (not boxes) still in the warehouse for a group: SUM(remaining)."""
        row = self._conn.execute(
            "SELECT COALESCE(SUM(remaining), 0) AS n FROM tags "
            "WHERE item_type=? AND bol_number=? AND building=?",
            (item_type, bol_number, building),
        ).fetchone()
        return row["n"] if row else 0

    @staticmethod
    def _tag_dict(row):
        return {
            "epc": row["epc"],
            "item_type": row["item_type"],
            "item_name": row["item_name"],
            "bol_number": row["bol_number"],
            "po_number": row["po_number"],
            "bol_doc_id": row["bol_doc_id"],
            "building": row["building"],
            "sector": row["sector"],
            "vendor": row["vendor"],
            "sku": row["sku"],
            "mfc_date": row["mfc_date"],
            "quantity": row["quantity"],
            "remaining": row["remaining"],
            "status": row["status"],
            "received_at": row["received_at"],
            "delivered_at": row["delivered_at"],
            "checkout_building": row["checkout_building"],
            "flag": row["flag"],
            "flagged_at": row["flagged_at"],
        }

    # -- writes --------------------------------------------------------------
    EPC_LENGTH = 24   # 96-bit EPC in hex characters

    def allocate_epcs(self, count=1):
        """Mint unique EPCs for printer-encoded labels.

        EPC = PRINTER_EPC_PREFIX + zero-padded hex serial. The serial counter
        persists in sync_state (key/value bookkeeping table), and any value
        that somehow already exists in tags (e.g. a colliding factory EPC) is
        skipped, so an allocated EPC is never a duplicate.
        """
        prefix = config.PRINTER_EPC_PREFIX.upper()
        width = self.EPC_LENGTH - len(prefix)
        epcs = []
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM sync_state WHERE key='epc_serial'"
            ).fetchone()
            serial = int(row["value"]) if row else 0
            while len(epcs) < count:
                serial += 1
                epc = f"{prefix}{serial:0{width}X}"
                if not self._conn.execute(
                        "SELECT 1 FROM tags WHERE epc=?", (epc,)).fetchone():
                    epcs.append(epc)
            self._conn.execute(
                "INSERT INTO sync_state (key, value) VALUES ('epc_serial', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(serial),))
            self._conn.commit()
        return epcs

    def receive_shipment(self, epcs, item_type, building, bol_number, vendor,
                         item_fields=None, bol_doc_id=None, po_number="",
                         sector=""):
        """Check In: record a shipment's tags and report the group's quantity."""
        item_fields = item_fields or {}
        item_name = (item_fields.get("item_name") or "").strip()
        sku = (item_fields.get("sku") or "").strip()
        mfc_date = (item_fields.get("mfc_date") or "").strip()
        units = _as_quantity(item_fields.get("quantity"))
        ts = _now()

        ordered = list(dict.fromkeys(e.upper() for e in epcs))
        added, added_units, duplicates, added_epcs = 0, 0, [], []

        with self._lock:
            existing = set()
            for epc in ordered:
                row = self._conn.execute(
                    "SELECT epc FROM tags WHERE epc=?", (epc,)).fetchone()
                if row:
                    existing.add(epc)

            for epc in ordered:
                if epc in existing:
                    duplicates.append(epc)
                    continue
                self._conn.execute(
                    "INSERT INTO tags (epc, item_type, item_name, bol_number, "
                    "po_number, bol_doc_id, building, sector, vendor, sku, "
                    "mfc_date, quantity, remaining, status, received_at, "
                    "delivered_at, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (epc, item_type, item_name, bol_number, po_number,
                     bol_doc_id, building, sector, vendor, sku, mfc_date,
                     units, units, STATUS_IN, ts, "", ts, ts),
                )
                detail = f"qty {units}"
                if item_name:
                    detail += f", name {item_name}"
                if po_number:
                    detail += f", PO {po_number}"
                self._log("IN", epc, item_type, bol_number, building, vendor,
                          detail=detail)
                added += 1
                added_units += units
                added_epcs.append(epc)

            qty = self._group_in_warehouse_qty(item_type, bol_number, building)
            self._conn.commit()

        box_word = "box" if added == 1 else "boxes"
        msg = (f"Received {added} {box_word} ({added_units} units) of {item_type} "
               f"(BOL {bol_number or 'n/a'}, {building or 'n/a'}).")
        if duplicates:
            msg += f" {len(duplicates)} already on file."
        return {"ok": True, "message": msg, "added": added,
                "added_units": added_units, "quantity": units,
                "duplicates": duplicates, "epcs": added_epcs,
                "epc": added_epcs[0] if added_epcs else "",
                "qty": qty, "item_type": item_type, "item_name": item_name,
                "bol_number": bol_number, "po_number": po_number,
                "bol_doc_id": bol_doc_id,
                "building": building, "sector": sector, "vendor": vendor,
                "sku": sku, "mfc_date": mfc_date}

    def amend_checkin(self, epc, fields):
        """Operator correction of a just-checked-in box (item name, Item No.,
        mfc date, quantity).

        Not PIN-gated: this fixes typos right after a trigger pull, before the
        box has been touched. Quantity edits also reset `remaining` (nothing has
        been drawn from a box that was just received). Logs an EDIT event.
        """
        epc = epc.upper()
        fields = fields or {}
        ts = _now()
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM tags WHERE epc=?", (epc,)).fetchone()
            if row is None:
                return {"ok": False, "message": f"{epc} is not registered.",
                        "epc": epc}

            sets, params, changes = [], [], []
            for key in ("item_name", "sku", "mfc_date"):
                if key not in fields:
                    continue
                new_val = ("" if fields[key] is None else str(fields[key])).strip()
                if new_val != (row[key] or ""):
                    sets.append(f"{key}=?")
                    params.append(new_val)
                    changes.append(f"{key}: '{row[key]}' -> '{new_val}'")
            if "quantity" in fields:
                new_qty = _as_quantity(fields["quantity"])
                if new_qty != row["quantity"]:
                    sets += ["quantity=?", "remaining=?"]
                    params += [new_qty, new_qty]
                    changes.append(f"quantity: '{row['quantity']}' -> '{new_qty}'")

            if sets:
                sets.append("updated_at=?")
                params.append(ts)
                params.append(epc)
                self._conn.execute(
                    f"UPDATE tags SET {', '.join(sets)} WHERE epc=?", params)
                self._log("EDIT", epc, row["item_type"], row["bol_number"],
                          row["building"], row["vendor"],
                          detail="check-in fix: " + "; ".join(changes))
            updated = self._conn.execute(
                "SELECT * FROM tags WHERE epc=?", (epc,)).fetchone()
            qty = self._group_in_warehouse_qty(
                row["item_type"], row["bol_number"], row["building"])
            self._conn.commit()
        return {"ok": True,
                "message": ("Updated " + epc + ".") if sets else "No changes.",
                "tag": self._tag_dict(updated), "qty": qty}

    # -- bill-of-lading documents ---------------------------------------------
    # ocr_text is deliberately left out of the dict: it's stored for debugging
    # and future search, not something the UI needs on every payload.
    @staticmethod
    def _bol_doc_dict(row):
        try:
            line_items = json.loads(row["line_items"] or "[]")
        except (ValueError, TypeError):
            line_items = []
        return {"id": row["id"], "bol_number": row["bol_number"],
                "filename": row["filename"], "source": row["source"],
                "pages": row["pages"], "vendor": row["vendor"],
                "po_number": row["po_number"],
                "line_items": line_items,
                "auto_named": bool(row["auto_named"]),
                "created_at": row["created_at"]}

    def create_bol_doc(self, bol_number, filename, source="scan", pages=1,
                       vendor="", po_number="", ocr_text="", line_items=None):
        """Register a scanned/uploaded BOL PDF and log a BOL_SCAN event.

        vendor/po_number/line_items are OCR guesses (may be empty); the BOL
        number passed in is either an OCR guess or a generated placeholder,
        so the doc starts auto_named=1 until the operator confirms it via
        rename.
        """
        ts = _now()
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO bol_docs (bol_number, filename, source, pages, "
                "vendor, po_number, ocr_text, line_items, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (bol_number, filename, source, pages, vendor, po_number,
                 ocr_text, json.dumps(line_items or []), ts))
            doc_id = cur.lastrowid
            extracted = ", ".join(
                s for s in (f"vendor {vendor}" if vendor else "",
                            f"PO {po_number}" if po_number else "") if s)
            self._log("BOL_SCAN", "", bol_number=bol_number, vendor=vendor,
                      detail=f"{source}: {filename} ({pages} page(s))"
                             + (f"; OCR: {extracted}" if extracted else ""))
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM bol_docs WHERE id=?", (doc_id,)).fetchone()
        return self._bol_doc_dict(row)

    def get_bol_doc(self, doc_id):
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM bol_docs WHERE id=?", (doc_id,)).fetchone()
        return self._bol_doc_dict(row) if row else None

    def list_bol_docs(self, limit=15):
        """BOL documents (newest first), each with its linked box count.

        `limit` of 0/None returns every document (the BOL Documents view);
        the default keeps the check-in resume list short.
        """
        sql = ("SELECT d.*, (SELECT COUNT(*) FROM tags t "
               "WHERE t.bol_doc_id = d.id) AS boxes "
               "FROM bol_docs d ORDER BY d.id DESC")
        params = ()
        if limit:
            sql += " LIMIT ?"
            params = (limit,)
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        docs = []
        for r in rows:
            d = self._bol_doc_dict(r)
            d["boxes"] = r["boxes"]
            docs.append(d)
        return docs

    def delete_bol_doc(self, doc_id):
        """Admin: delete a BOL document (DB row + PDF file on disk).

        Boxes filed under it are NOT touched apart from losing the document
        link (bol_doc_id -> NULL): they keep their BOL number text and stay
        in inventory. Events are kept as an audit trail plus a BOL_DELETE.
        """
        ts = _now()
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM bol_docs WHERE id=?", (doc_id,)).fetchone()
            if row is None:
                return {"ok": False, "message": f"BOL document {doc_id} not found."}
            cur = self._conn.execute(
                "UPDATE tags SET bol_doc_id=NULL, updated_at=? WHERE bol_doc_id=?",
                (ts, doc_id))
            unlinked = cur.rowcount
            self._conn.execute("DELETE FROM bol_docs WHERE id=?", (doc_id,))
            self._log("BOL_DELETE", "", bol_number=row["bol_number"],
                      detail=(f"deleted document ({row['filename']}, "
                              f"{row['pages']} page(s)); "
                              f"{unlinked} box(es) unlinked"))
            self._conn.commit()
        try:
            os.remove(os.path.join(config.SCANS_DIR, row["filename"]))
        except OSError:
            pass  # already gone / never scanned to disk; the row is the record
        msg = f"Deleted BOL '{row['bol_number']}' and its PDF."
        if unlinked:
            msg += (f" {unlinked} box(es) keep their BOL number "
                    "but no longer link to a document.")
        return {"ok": True, "message": msg, "unlinked": unlinked,
                "id": doc_id}

    def rename_bol_doc(self, doc_id, new_number):
        """Set a document's BOL number; tags already filed under it follow."""
        new_number = (new_number or "").strip()
        if not new_number:
            return {"ok": False, "message": "BOL number cannot be empty."}
        ts = _now()
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM bol_docs WHERE id=?", (doc_id,)).fetchone()
            if row is None:
                return {"ok": False, "message": f"BOL document {doc_id} not found."}
            old = row["bol_number"]
            # A human typed this number: stop OCR re-extraction (Add page)
            # from ever overwriting it.
            self._conn.execute(
                "UPDATE bol_docs SET bol_number=?, auto_named=0 WHERE id=?",
                (new_number, doc_id))
            cur = self._conn.execute(
                "UPDATE tags SET bol_number=?, updated_at=? WHERE bol_doc_id=?",
                (new_number, ts, doc_id))
            updated = cur.rowcount
            self._log("BOL_RENAME", "", bol_number=new_number,
                      detail=f"was '{old}'; {updated} box(es) updated")
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM bol_docs WHERE id=?", (doc_id,)).fetchone()
        return {"ok": True, "message": f"BOL renamed to '{new_number}'.",
                "doc": self._bol_doc_dict(row), "tags_updated": updated}

    def set_bol_doc_pages(self, doc_id, pages):
        """Update the stored page count (after an Add-page rescan)."""
        with self._lock:
            self._conn.execute(
                "UPDATE bol_docs SET pages=? WHERE id=?", (pages, doc_id))
            self._conn.commit()

    def apply_bol_extraction(self, doc_id, bol_number="", vendor="",
                             po_number="", ocr_text="", line_items=None):
        """Fold a re-run OCR extraction (after Add page) into the document.

        Non-destructive: the BOL number is only replaced while it is still
        machine-generated (auto_named=1) -- and tags already filed under the
        doc follow, as with rename. Vendor/PO/line items fill in only if
        still empty. The stored ocr_text is always refreshed (it covers all
        pages now).
        """
        ts = _now()
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM bol_docs WHERE id=?", (doc_id,)).fetchone()
            if row is None:
                return None
            self._conn.execute(
                "UPDATE bol_docs SET ocr_text=? WHERE id=?", (ocr_text, doc_id))
            if line_items and (row["line_items"] or "[]") in ("", "[]"):
                self._conn.execute(
                    "UPDATE bol_docs SET line_items=? WHERE id=?",
                    (json.dumps(line_items), doc_id))
            if vendor and not row["vendor"]:
                self._conn.execute(
                    "UPDATE bol_docs SET vendor=? WHERE id=?", (vendor, doc_id))
            if po_number and not row["po_number"]:
                self._conn.execute(
                    "UPDATE bol_docs SET po_number=? WHERE id=?",
                    (po_number, doc_id))
            if (bol_number and row["auto_named"]
                    and bol_number != row["bol_number"]):
                self._conn.execute(
                    "UPDATE bol_docs SET bol_number=? WHERE id=?",
                    (bol_number, doc_id))
                self._conn.execute(
                    "UPDATE tags SET bol_number=?, updated_at=? "
                    "WHERE bol_doc_id=?",
                    (bol_number, ts, doc_id))
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM bol_docs WHERE id=?", (doc_id,)).fetchone()
        return self._bol_doc_dict(row)

    # -- shipment notes --------------------------------------------------------
    # A shipment has no row of its own (it's an aggregation over tags), so notes
    # key on the same triple that identifies it: (item_type, bol_number,
    # building). Append-only: each note keeps its own timestamp.
    @staticmethod
    def _note_dict(row):
        return {"id": row["id"], "ts": row["ts"], "item_type": row["item_type"],
                "bol_number": row["bol_number"], "building": row["building"],
                "text": row["text"]}

    def add_note(self, item_type, bol_number, building, text):
        """Attach a timestamped note to a shipment and log a NOTE event."""
        text = (text or "").strip()
        item_type = (item_type or "").strip()
        if not text:
            return {"ok": False, "message": "Note text is required."}
        if not item_type:
            return {"ok": False, "message": "An item type is required."}
        bol_number = (bol_number or "").strip()
        building = (building or "").strip()
        ts = _now()
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO notes (ts, item_type, bol_number, building, text) "
                "VALUES (?,?,?,?,?)",
                (ts, item_type, bol_number, building, text))
            note_id = cur.lastrowid
            detail = text if len(text) <= 200 else text[:197] + "..."
            self._log("NOTE", "", item_type, bol_number, building,
                      detail=detail)
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
        return {"ok": True, "message": "Note added.",
                "note": self._note_dict(row)}

    def list_notes(self, item_type, bol_number=None, building=None):
        """Notes for a shipment, oldest first.

        Check-in passes the exact triple; a warehouse row passes only its
        grouped dimension (a BOL row can span buildings and vice versa).
        None skips a filter; '' matches shipments recorded with a blank value.
        """
        where, params = ["item_type = ?"], [item_type]
        if bol_number is not None:
            where.append("bol_number = ?")
            params.append(bol_number)
        if building is not None:
            where.append("building = ?")
            params.append(building)
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM notes WHERE " + " AND ".join(where) +
                " ORDER BY id", params).fetchall()
        return [self._note_dict(r) for r in rows]

    def delete_note(self, note_id):
        """Admin: remove a note (typo fix). Logs a NOTE_DEL event."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
            if row is None:
                return {"ok": False, "message": f"Note {note_id} not found."}
            self._conn.execute("DELETE FROM notes WHERE id=?", (note_id,))
            self._log("NOTE_DEL", "", row["item_type"], row["bol_number"],
                      row["building"], detail=row["text"][:200])
            self._conn.commit()
        return {"ok": True, "message": "Note deleted."}

    def lookup_for_checkout(self, epc):
        """Check Out step 1: look up a box for the two-step confirm UI.

        Returns the box's details (including units `remaining`) so the operator
        can choose how many to draw down. Does NOT commit anything. `ok` is False
        for an unregistered or already-empty (fully delivered) box.
        """
        epc = epc.upper()
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM tags WHERE epc=?", (epc,)).fetchone()

        if row is None:
            return {"ok": False, "message": f"{epc} is not registered.",
                    "epc": epc}
        if row["remaining"] <= 0:
            return {"ok": False,
                    "message": f"{row['item_type']} ({epc}) is already fully delivered.",
                    "epc": epc, "item_type": row["item_type"],
                    "remaining": 0, "quantity": row["quantity"]}

        return {"ok": True, "epc": epc, "item_type": row["item_type"],
                "item_name": row["item_name"],
                "bol_number": row["bol_number"], "building": row["building"],
                "vendor": row["vendor"], "sku": row["sku"],
                "quantity": row["quantity"], "remaining": row["remaining"]}

    def deliver_units(self, epc, amount=None, checkout_building=None):
        """Check Out step 2: draw `amount` units out of a box and commit.

        `amount` is clamped to [1, remaining]; None means "the whole box". When a
        box hits 0 it becomes Delivered, otherwise Partial. Reports the group's
        remaining units after the draw. `checkout_building` is the destination
        chosen by the operator; if it differs from the building the box was
        received for, the tag is flagged.
        """
        with self._lock:
            result = self._deliver_units_locked(epc, amount, checkout_building)
            self._conn.commit()
        return result

    def _deliver_units_locked(self, epc, amount=None, checkout_building=None):
        """Core of one checkout draw. Caller holds self._lock and commits (so
        fulfill_request can apply several draws in a single transaction)."""
        epc = epc.upper()
        ts = _now()
        delivered = _today()
        checkout_building = (checkout_building or "").strip()

        row = self._conn.execute(
            "SELECT * FROM tags WHERE epc=?", (epc,)).fetchone()

        if row is None:
            self._log("OUT", epc, "UNKNOWN", detail="not registered")
            return {"ok": False, "message": f"{epc} is not registered.",
                    "epc": epc}

        remaining = row["remaining"]
        if remaining <= 0:
            return {"ok": False,
                    "message": f"{row['item_type']} ({epc}) is already fully delivered.",
                    "epc": epc, "item_type": row["item_type"]}

        take = remaining if amount is None else _as_quantity(amount)
        take = max(1, min(take, remaining))
        new_remaining = remaining - take

        if new_remaining == 0:
            new_status = STATUS_DELIVERED
        else:
            new_status = STATUS_PARTIAL
        # Record the most recent checkout time on every draw (partial or
        # full) so a partially delivered box still shows when it last went out.
        delivered_at = ts

        # Destination differs from the building the box came in for: flag it.
        mismatch = bool(checkout_building and row["building"]
                        and checkout_building != row["building"])
        flag = ""
        if mismatch:
            flag = (f"Checked out to Bldg {checkout_building} but received "
                    f"for Bldg {row['building']}")

        sets = ["remaining=?", "status=?", "delivered_at=?", "updated_at=?"]
        params = [new_remaining, new_status, delivered_at, ts]
        if checkout_building:
            sets.append("checkout_building=?")
            params.append(checkout_building)
        if mismatch:
            sets += ["flag=?", "flagged_at=?"]
            params += [flag, ts]
        params.append(epc)
        self._conn.execute(
            f"UPDATE tags SET {', '.join(sets)} WHERE epc=?", params)

        dest = f" to Bldg {checkout_building}" if checkout_building else ""
        self._log("OUT", epc, row["item_type"], row["bol_number"],
                  row["building"], row["vendor"],
                  detail=f"delivered {take} unit(s){dest}, {new_remaining} left")
        if mismatch:
            self._log("FLAG", epc, row["item_type"], row["bol_number"],
                      row["building"], row["vendor"], detail=flag)
        qty_remaining = self._group_in_warehouse_qty(
            row["item_type"], row["bol_number"], row["building"])

        return {"ok": True,
                "message": f"Delivered {take} unit(s) of {row['item_type']} ({epc}) to site.",
                "epc": epc, "item_type": row["item_type"],
                "bol_number": row["bol_number"], "building": row["building"],
                "checkout_building": checkout_building,
                "flag": flag,
                "delivered": take, "box_remaining": new_remaining,
                "box_status": new_status, "delivered_at": delivered,
                "qty_remaining": qty_remaining}

    def record_inventory(self, epcs):
        """Inventory sweep: report tags present, grouped by item type.

        Read-only with respect to quantities (a partial sweep must not zero out
        shipments it didn't cover); it logs COUNT rows for the audit trail. A tag
        that is already Delivered but detected here is persistently flagged: it
        should not physically be in the warehouse.
        """
        counts, unknown, flagged, items = {}, [], [], []
        ts = _now()
        with self._lock:
            for epc in sorted(set(e.upper() for e in epcs)):
                row = self._conn.execute(
                    "SELECT * FROM tags WHERE epc=?", (epc,)).fetchone()
                if row is None:
                    unknown.append(epc)
                    self._log("COUNT", epc, "UNKNOWN")
                    continue
                items.append(self._tag_dict(row))
                if row["remaining"] <= 0:
                    flag = (f"Checked out {_date_of(row['delivered_at'])}; "
                            "detected in sweep")
                    self._conn.execute(
                        "UPDATE tags SET flag=?, flagged_at=?, updated_at=? WHERE epc=?",
                        (flag, ts, ts, epc))
                    self._log("FLAG", epc, row["item_type"], row["bol_number"],
                              row["building"], row["vendor"], detail=flag)
                    flagged.append({
                        "epc": epc, "item_type": row["item_type"],
                        "bol_number": row["bol_number"], "building": row["building"],
                        "delivered_at": _date_of(row["delivered_at"]), "flag": flag,
                    })
                else:
                    counts[row["item_type"]] = (
                        counts.get(row["item_type"], 0) + row["remaining"])
                    self._log("COUNT", epc, row["item_type"], row["bol_number"],
                              row["building"], row["vendor"],
                              detail=f"{row['remaining']} unit(s)")
            self._conn.commit()

        return {"counts": counts, "unknown": unknown, "flagged": flagged,
                "items": items,
                "total": sum(counts.values()) + len(unknown) + len(flagged)}

    def compare_inventory(self, epcs):
        """Reconcile a sweep session against the expected warehouse contents.

        Read-only, no events logged. Every tag with units remaining is expected
        to be physically present; partition them by whether their EPC appears
        in the (session-accumulated) scanned set and report the ones missing.
        """
        scanned = set(e.upper() for e in epcs)
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM tags WHERE remaining > 0 "
                "ORDER BY item_type, bol_number, epc").fetchall()
        found_epcs, missing = [], []
        for row in rows:
            if row["epc"] in scanned:
                found_epcs.append(row["epc"])
            else:
                missing.append(self._tag_dict(row))
        return {"expected": len(rows), "found_count": len(found_epcs),
                "missing_count": len(missing), "missing": missing,
                "found_epcs": found_epcs}

    # -- reads (interactive inventory view) ----------------------------------
    @staticmethod
    def _filter_where(filters):
        """Shared warehouse-filter WHERE builder (tree, drill-down, export).

        Supported keys: bol (substring), building (exact), received_from/_to
        and checked_out_from/_to (date bounds, yyyy-mm-dd). Timestamps are ISO
        strings, so date-only comparison uses their first 10 chars.
        """
        f = filters or {}
        where, params = [], []
        if f.get("bol"):
            where.append("bol_number LIKE ?")
            params.append(f"%{f['bol']}%")
        if f.get("building"):
            where.append("building = ?")
            params.append(str(f["building"]))
        if f.get("received_from"):
            where.append("substr(received_at, 1, 10) >= ?")
            params.append(f["received_from"])
        if f.get("received_to"):
            where.append("substr(received_at, 1, 10) <= ?")
            params.append(f["received_to"])
        if f.get("checked_out_from"):
            where.append("delivered_at != '' AND substr(delivered_at, 1, 10) >= ?")
            params.append(f["checked_out_from"])
        if f.get("checked_out_to"):
            where.append("delivered_at != '' AND substr(delivered_at, 1, 10) <= ?")
            params.append(f["checked_out_to"])
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        return clause, params

    def inventory_tree(self, group_by="bol", filters=None):
        """Nested view: item type -> groups (by BOL# or Building#) with qty/status.

        Only counts tags still in the warehouse; a group whose tags are all
        delivered drops to qty 0 and status Delivered. Each group also carries
        the distinct values of the OTHER dimension (`other_values`) so grouping
        by building still shows which BOLs are involved, and vice versa, plus
        the distinct vendors of its tags (`vendors`) and how many of its boxes
        carry a warning flag (`flagged`).
        Named item types (config.NAMED_ITEM_TYPES, e.g. W.I.F.) group by the
        per-box component name instead, with the toggled dimension shown as
        the other values. `filters` narrows the tags considered.
        """
        gcol = GROUP_COLUMNS.get(group_by, "bol_number")
        ocol = "building" if gcol == "bol_number" else "bol_number"
        named = list(config.NAMED_ITEM_TYPES)
        named_in = ",".join("?" for _ in named) or "''"
        clause, params = self._filter_where(filters)
        with self._lock:
            rows = self._conn.execute(
                f"""
                SELECT item_type,
                       CASE WHEN item_type IN ({named_in})
                            THEN item_name ELSE {gcol} END  AS gval,
                       CASE WHEN item_type IN ({named_in})
                            THEN {gcol} ELSE {ocol} END     AS oval,
                       vendor,
                       COALESCE(SUM(remaining), 0)         AS in_wh,
                       COALESCE(SUM(quantity), 0)          AS capacity,
                       COUNT(*)                            AS boxes,
                       SUM(CASE WHEN flag <> '' THEN 1 ELSE 0 END)
                                                           AS flagged,
                       MIN(received_at)                    AS first_received,
                       MAX(bol_doc_id)                     AS doc_id
                FROM tags
                {clause}
                GROUP BY item_type, gval, oval, vendor
                ORDER BY item_type, gval, oval
                """,
                named + named + params,
            ).fetchall()
            note_rows = self._conn.execute(
                f"SELECT item_type, {gcol} AS gval, COUNT(*) AS n "
                "FROM notes GROUP BY item_type, gval").fetchall()
            type_note_rows = self._conn.execute(
                "SELECT item_type, COUNT(*) AS n FROM notes "
                "GROUP BY item_type").fetchall()

        note_counts = {(r["item_type"], r["gval"] or ""): r["n"]
                       for r in note_rows}
        # Named types group by item_name, which notes don't key on; every
        # component row carries the type-wide note count instead.
        type_note_counts = {r["item_type"]: r["n"] for r in type_note_rows}

        # SQL groups by (type, group, other) so the sub-rows are merged here,
        # accumulating the distinct other-dimension values along the way.
        types = {}
        groups = {}
        for r in rows:
            is_named = r["item_type"] in named
            t = types.setdefault(r["item_type"], {"item_type": r["item_type"],
                                                  "named": is_named,
                                                  "qty": 0, "groups": []})
            key = (r["item_type"], r["gval"] or "")
            g = groups.get(key)
            if g is None:
                g = {"value": r["gval"] or "", "in_wh": 0, "capacity": 0,
                     "boxes": 0, "flagged": 0, "received_at": "",
                     "bol_doc_id": None,
                     "note_count": (type_note_counts.get(r["item_type"], 0)
                                    if is_named else note_counts.get(key, 0)),
                     "_others": set(), "_vendors": set()}
                groups[key] = g
                t["groups"].append(g)
            g["in_wh"] += r["in_wh"] or 0
            g["capacity"] += r["capacity"] or 0
            g["boxes"] += r["boxes"]
            g["flagged"] += r["flagged"] or 0
            if r["doc_id"] and not g["bol_doc_id"]:
                g["bol_doc_id"] = r["doc_id"]
            first = r["first_received"] or ""
            # ISO timestamps compare lexicographically.
            if first and (not g["received_at"] or first < g["received_at"]):
                g["received_at"] = first
            if r["oval"]:
                g["_others"].add(str(r["oval"]))
            if r["vendor"]:
                g["_vendors"].add(str(r["vendor"]))

        for t in types.values():
            for g in t["groups"]:
                qty = g["in_wh"]
                t["qty"] += qty
                if qty == 0:
                    status = STATUS_DELIVERED
                elif qty == g["capacity"]:
                    status = STATUS_IN
                else:
                    status = STATUS_PARTIAL
                g.update({
                    "qty": qty,
                    "total": g["capacity"],
                    "received": _date_of(g["received_at"]),
                    "status": status,
                    "other_values": sorted(g.pop("_others")),
                    "vendors": sorted(g.pop("_vendors")),
                })
        return {"group_by": group_by, "types": list(types.values())}

    def group_tags(self, item_type, group_by, value, filters=None):
        """Individual tags within one (item_type, group) cell, for drill-down.

        Named item types drill down by component name (item_name) instead of
        the BOL/Building toggle.
        """
        gcol = ("item_name" if item_type in config.NAMED_ITEM_TYPES
                else GROUP_COLUMNS.get(group_by, "bol_number"))
        clause, fparams = self._filter_where(filters)
        clause = clause.replace(" WHERE ", " AND ", 1)
        with self._lock:
            rows = self._conn.execute(
                f"SELECT * FROM tags WHERE item_type=? AND {gcol}=?{clause} "
                "ORDER BY received_at, epc",
                [item_type, value] + fparams,
            ).fetchall()
        return {"item_type": item_type, "group_by": group_by, "value": value,
                "tags": [self._tag_dict(r) for r in rows]}

    def export_rows(self, filters=None):
        """Flat per-box rows for CSV/PDF export, honoring the warehouse filters."""
        clause, params = self._filter_where(filters)
        with self._lock:
            rows = self._conn.execute(
                f"SELECT * FROM tags{clause} "
                "ORDER BY item_type, bol_number, received_at, epc",
                params,
            ).fetchall()
        return [self._tag_dict(r) for r in rows]

    def find_tag(self, epc):
        """Return a single tag dict (for the finder) or None."""
        epc = epc.upper()
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM tags WHERE epc=?", (epc,)).fetchone()
        return self._tag_dict(row) if row else None

    def item_name_suggestions(self, item_type):
        """Distinct component names already used for a type (autocomplete)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT DISTINCT item_name FROM tags "
                "WHERE item_type=? AND item_name != '' "
                "ORDER BY item_name COLLATE NOCASE",
                (item_type,)).fetchall()
        return [r["item_name"] for r in rows]

    # Event-log filter categories -> the action(s) they include.
    EVENT_FILTERS = {"checkin": ("IN",), "checkout": ("OUT",), "scan": ("COUNT",)}

    def list_events(self, filter="all", epc=None, limit=500):
        """Audit-log read: events newest-first, optionally narrowed by filter/EPC.

        `filter` is one of 'all', 'checkin', 'checkout', 'scan'. `epc` does a
        case-insensitive substring match so partial pastes work. Capped at
        `limit` rows (most recent).
        """
        where, params = [], []
        actions = self.EVENT_FILTERS.get(filter)
        if actions:
            where.append("action IN (%s)" % ",".join("?" * len(actions)))
            params.extend(actions)
        if epc:
            where.append("epc LIKE ?")
            params.append(f"%{epc.upper()}%")
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        try:
            limit = max(1, min(int(limit), 5000))
        except (TypeError, ValueError):
            limit = 500
        params.append(limit)

        with self._lock:
            rows = self._conn.execute(
                "SELECT id, ts, action, epc, item_type, bol_number, building, "
                "vendor, detail FROM events" + clause +
                " ORDER BY id DESC LIMIT ?",
                params,
            ).fetchall()
        return [{
            "id": r["id"], "ts": r["ts"], "action": r["action"],
            "epc": r["epc"] or "", "item_type": r["item_type"] or "",
            "bol_number": r["bol_number"] or "", "building": r["building"] or "",
            "vendor": r["vendor"] or "", "detail": r["detail"] or "",
        } for r in rows]

    # -- admin ---------------------------------------------------------------
    def clear_all(self):
        """Delete every tag and BOL document (PDF files included).

        Events are kept as an audit trail (plus a CLEAR).
        """
        with self._lock:
            removed = self._conn.execute(
                "SELECT COUNT(*) AS n FROM tags").fetchone()["n"]
            doc_files = [r["filename"] for r in self._conn.execute(
                "SELECT filename FROM bol_docs").fetchall()]
            self._conn.execute("DELETE FROM tags")
            self._conn.execute("DELETE FROM bol_docs")
            self._conn.execute("DELETE FROM notes")
            self._log("CLEAR", "", detail=(f"cleared {removed} tag(s), "
                                           f"{len(doc_files)} BOL document(s)"))
            self._conn.commit()
        for filename in doc_files:
            try:
                os.remove(os.path.join(config.SCANS_DIR, filename))
            except OSError:
                pass
        return {"ok": True, "removed": removed,
                "message": f"Cleared {removed} tag(s) from the database."}

    def delete_group(self, item_type, group_by, value):
        """Admin: delete every tag in one (item_type, group) warehouse cell.

        Events are kept as an audit trail; a DELETE event records what was
        removed and how many boxes/units it covered.
        """
        if item_type in config.NAMED_ITEM_TYPES:
            gcol, label = "item_name", "Item Name"
        else:
            gcol = GROUP_COLUMNS.get(group_by, "bol_number")
            label = "Building" if gcol == "building" else "BOL"
        with self._lock:
            row = self._conn.execute(
                f"SELECT COUNT(*) AS boxes, COALESCE(SUM(remaining), 0) AS units "
                f"FROM tags WHERE item_type=? AND {gcol}=?",
                (item_type, value),
            ).fetchone()
            boxes, units = row["boxes"], row["units"]
            if not boxes:
                return {"ok": False, "removed": 0,
                        "message": (f"No {item_type} boxes found for "
                                    f"{label} '{value or '(blank)'}'.")}
            self._conn.execute(
                f"DELETE FROM tags WHERE item_type=? AND {gcol}=?",
                (item_type, value))
            self._log("DELETE", "", item_type,
                      bol_number=value if gcol == "bol_number" else "",
                      building=value if gcol == "building" else "",
                      detail=(f"deleted group {label} '{value or '(blank)'}': "
                              f"{boxes} box(es), {units} unit(s)"))
            self._conn.commit()
        return {"ok": True, "removed": boxes,
                "message": (f"Deleted {boxes} box(es) of {item_type} "
                            f"({label} '{value or '(blank)'}').")}

    # Fields an admin may edit on a tag.
    EDITABLE = ("item_type", "item_name", "bol_number", "po_number",
                "building", "sector", "vendor", "sku", "mfc_date", "quantity",
                "remaining", "status")

    def update_tag(self, epc, fields):
        """Admin: overwrite editable fields on a tag. Returns the updated tag."""
        epc = epc.upper()
        fields = fields or {}
        ts = _now()
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM tags WHERE epc=?", (epc,)).fetchone()
            if row is None:
                return {"ok": False, "message": f"{epc} is not registered.",
                        "epc": epc}

            sets, params, changes = [], [], []
            # The new quantity (if edited) bounds remaining below.
            new_quantity = (_as_quantity(fields["quantity"])
                            if "quantity" in fields else row["quantity"])
            for key in self.EDITABLE:
                if key not in fields:
                    continue
                if key == "quantity":
                    new_val = new_quantity
                elif key == "remaining":
                    n = _as_quantity(fields["remaining"], default=0)
                    n = 0 if n < 0 else n
                    new_val = min(n, new_quantity)
                else:
                    new_val = ("" if fields[key] is None else str(fields[key])).strip()
                if str(new_val) != str(row[key] if row[key] is not None else ""):
                    sets.append(f"{key}=?")
                    params.append(new_val)
                    changes.append(f"{key}: '{row[key]}' -> '{new_val}'")

            # Keep remaining / delivered_at / flag consistent with a status change
            # (unless remaining was edited explicitly in the same request).
            if "status" in fields and "remaining" not in fields:
                if fields["status"] == STATUS_IN:
                    sets += ["remaining=?", "delivered_at=?", "flag=?", "flagged_at=?"]
                    params += [new_quantity, "", "", ""]
                elif fields["status"] == STATUS_DELIVERED:
                    sets.append("remaining=?")
                    params.append(0)
                    if not row["delivered_at"]:
                        sets.append("delivered_at=?")
                        params.append(ts)
            elif "remaining" in fields:
                # Editing remaining directly: derive the matching status so the
                # stored status can't disagree with the unit count.
                new_remaining = min(
                    max(_as_quantity(fields["remaining"], default=0), 0), new_quantity)
                derived = (STATUS_DELIVERED if new_remaining == 0
                           else STATUS_IN if new_remaining == new_quantity
                           else STATUS_PARTIAL)
                if "status=?" not in sets:
                    sets.append("status=?")
                    params.append(derived)
                if derived == STATUS_DELIVERED and not row["delivered_at"]:
                    sets += ["delivered_at=?"]
                    params += [ts]
                elif derived == STATUS_IN:
                    sets += ["delivered_at=?", "flag=?", "flagged_at=?"]
                    params += ["", "", ""]

            if not sets:
                return {"ok": True, "message": "No changes.",
                        "tag": self._tag_dict(row)}

            sets.append("updated_at=?")
            params.append(ts)
            params.append(epc)
            self._conn.execute(
                f"UPDATE tags SET {', '.join(sets)} WHERE epc=?", params)
            self._log("EDIT", epc, fields.get("item_type", row["item_type"]),
                      detail="; ".join(changes) or "status/flag reset")
            updated = self._conn.execute(
                "SELECT * FROM tags WHERE epc=?", (epc,)).fetchone()
            self._conn.commit()
        return {"ok": True, "message": f"Updated {epc}.",
                "tag": self._tag_dict(updated)}

    def clear_flag(self, epc):
        """Admin: clear a tag's warning flag."""
        epc = epc.upper()
        ts = _now()
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM tags WHERE epc=?", (epc,)).fetchone()
            if row is None:
                return {"ok": False, "message": f"{epc} is not registered.",
                        "epc": epc}
            self._conn.execute(
                "UPDATE tags SET flag=?, flagged_at=?, updated_at=? WHERE epc=?",
                ("", "", ts, epc))
            self._log("UNFLAG", epc, row["item_type"])
            updated = self._conn.execute(
                "SELECT * FROM tags WHERE epc=?", (epc,)).fetchone()
            self._conn.commit()
        return {"ok": True, "message": f"Cleared flag on {epc}.",
                "tag": self._tag_dict(updated)}

    # -- vendors -------------------------------------------------------------
    def list_vendors(self):
        with self._lock:
            rows = self._conn.execute(
                "SELECT name FROM vendors ORDER BY name COLLATE NOCASE").fetchall()
        return [r["name"] for r in rows]

    def add_vendor(self, name):
        name = (name or "").strip()
        if not name:
            return {"ok": False, "message": "Vendor name is required.",
                    "vendors": self.list_vendors()}
        with self._lock:
            self._conn.execute(
                "INSERT OR IGNORE INTO vendors (name) VALUES (?)", (name,))
            self._log("VENDOR_ADD", "", detail=name)
            self._conn.commit()
        return {"ok": True, "message": f"Added vendor '{name}'.",
                "vendors": self.list_vendors()}

    def remove_vendor(self, name):
        name = (name or "").strip()
        with self._lock:
            self._conn.execute("DELETE FROM vendors WHERE name=?", (name,))
            self._log("VENDOR_DEL", "", detail=name)
            self._conn.commit()
        return {"ok": True, "message": f"Removed vendor '{name}'.",
                "vendors": self.list_vendors()}

    # -- cloud sync (used by sync.py) ------------------------------------------
    # The .exe is the source of truth for warehouse data; the cloud app keeps a
    # mirror. Small tables (tags/vendors/notes/bol_docs) are pushed as full
    # snapshots -- which naturally carries edits and deletes -- and the
    # append-only events table is pushed incrementally above a watermark.
    # What crosses the wire is defined by the sync contract
    # (packages/contract), shared with the cloud side.

    def export_snapshot(self):
        """Full dump of the mirrored tables, JSON-ready ({table: [rows...]}).

        Exactly the sync-contract columns are exported: a local-only column
        (e.g. bol_docs.ocr_text, hundreds of KB per doc) stays local simply
        by not being in the contract.
        """
        snap = {}
        with self._lock:
            for table in sync_contract.SNAPSHOT_TABLES:
                cols = ", ".join(sync_contract.columns(table))
                rows = self._conn.execute(
                    f"SELECT {cols} FROM {table} ORDER BY rowid").fetchall()
                snap[table] = [dict(r) for r in rows]
        return snap

    def events_since(self, after_id, limit=1000):
        """Events with id > after_id, oldest first, capped at `limit` rows.

        The cap bounds one exchange payload; the next cycle picks up where the
        ack left off.
        """
        cols = ", ".join(sync_contract.columns(sync_contract.EVENTS_TABLE))
        with self._lock:
            rows = self._conn.execute(
                f"SELECT {cols} FROM events WHERE id > ? ORDER BY id LIMIT ?",
                (after_id, limit)).fetchall()
        return [dict(r) for r in rows]

    def last_event_id(self):
        with self._lock:
            row = self._conn.execute(
                "SELECT COALESCE(MAX(id), 0) AS n FROM events").fetchone()
        return row["n"]

    def sync_get(self, key, default=""):
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM sync_state WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def sync_set(self, key, value):
        with self._lock:
            self._conn.execute(
                "INSERT INTO sync_state (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, str(value)))
            self._conn.commit()

    # -- material requests (pulled from the cloud) -----------------------------
    @staticmethod
    def _request_dict(row):
        return {"id": row["id"], "item_type": row["item_type"],
                "item_name": row["item_name"],
                "quantity": row["quantity"], "building": row["building"],
                "jobsite": row["jobsite"], "requester": row["requester"],
                "contact": row["contact"], "note": row["note"],
                "status": row["status"], "created_at": row["created_at"],
                "handled_at": row["handled_at"],
                "handler_note": row["handler_note"],
                "order_ref": row["order_ref"]}

    def upsert_pulled_requests(self, rows):
        """Store request rows pulled from the cloud. Idempotent.

        New ids are inserted as pending; ids already on file are left alone
        (the manager's handling is the local truth once a row is here). Logs a
        REQUEST event per new row so requests show in the audit trail.
        """
        added = []
        with self._lock:
            for r in rows or []:
                try:
                    rid = int(r["id"])
                except (KeyError, TypeError, ValueError):
                    continue
                have = self._conn.execute(
                    "SELECT id FROM requests WHERE id=?", (rid,)).fetchone()
                if have:
                    continue
                self._conn.execute(
                    "INSERT INTO requests (id, item_type, item_name, quantity, "
                    "building, jobsite, requester, contact, note, status, "
                    "created_at, order_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (rid, str(r.get("item_type") or ""),
                     str(r.get("item_name") or ""),
                     _as_quantity(r.get("quantity")),
                     str(r.get("building") or ""), str(r.get("jobsite") or ""),
                     str(r.get("requester") or ""), str(r.get("contact") or ""),
                     str(r.get("note") or ""), REQUEST_PENDING,
                     str(r.get("created_at") or _now()),
                     str(r.get("order_ref") or "")))
                label = str(r.get("item_type") or "?")
                if r.get("item_name"):
                    label += f" | {r.get('item_name')}"
                self._log("REQUEST", "", str(r.get("item_type") or ""),
                          building=str(r.get("building") or ""),
                          detail=(f"#{rid}: {r.get('quantity') or 1} x "
                                  f"{label} for "
                                  f"{r.get('jobsite') or r.get('requester') or 'jobsite'}"))
                added.append(rid)
            if added:
                self._conn.commit()
        return added

    def list_requests(self, status=None):
        """Requests, open ones (staging, then pending) first, then newest."""
        sql = "SELECT * FROM requests"
        params = ()
        if status:
            sql += " WHERE status=?"
            params = (status,)
        sql += (" ORDER BY CASE status WHEN 'staging' THEN 0"
                " WHEN 'pending' THEN 1 ELSE 2 END, id DESC")
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [self._request_dict(r) for r in rows]

    def count_pending_requests(self):
        """Open requests (pending or mid-staging) for the mode-card badge."""
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM requests WHERE status IN (?, ?)",
                (REQUEST_PENDING, REQUEST_STAGING)).fetchone()
        return row["n"]

    # Allowed manager transitions. fulfilled is deliberately absent: the only
    # way there is fulfill_request(), which also commits the checkout draws.
    _REQUEST_TRANSITIONS = {
        REQUEST_PENDING: (REQUEST_STAGING, REQUEST_DECLINED),
        REQUEST_STAGING: (REQUEST_PENDING, REQUEST_DECLINED),
    }

    def set_request_status(self, req_id, status, note=""):
        """Move a request between pending/staging/declined; pushed on next sync.

        pending -> staging   Fulfill clicked (boxes being scanned for exit)
        staging -> pending   staging canceled, nothing was committed
        any     -> declined  manager turns the request down
        """
        note = (note or "").strip()
        ts = _now()
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM requests WHERE id=?", (req_id,)).fetchone()
            if row is None:
                return {"ok": False, "message": f"Request #{req_id} not found."}
            allowed = self._REQUEST_TRANSITIONS.get(row["status"], ())
            if status not in allowed:
                return {"ok": False,
                        "message": (f"Request #{req_id} is {row['status']}; "
                                    f"cannot mark it {status}.")}
            self._conn.execute(
                "UPDATE requests SET status=?, handled_at=?, handler_note=?, "
                "status_dirty=1 WHERE id=?",
                (status, ts, note, req_id))
            action = ("REQUEST_PENDING" if status == REQUEST_PENDING
                      else "REQUEST_" + status.upper())
            self._log(action, "", row["item_type"],
                      building=row["building"],
                      detail=(f"#{req_id}: {row['quantity']} x "
                              f"{row['item_type']}"
                              + (f" -- {note}" if note else "")))
            self._conn.commit()
            updated = self._conn.execute(
                "SELECT * FROM requests WHERE id=?", (req_id,)).fetchone()
        return {"ok": True, "message": f"Request #{req_id} {status}.",
                "request": self._request_dict(updated)}

    def fulfill_request(self, req_id, draws, note=""):
        """Commit staged checkout draws and mark the request fulfilled, in one
        transaction.

        `draws` is a list of {"epc", "amount", "building"} built up in the
        checkout screen. Each is applied via the normal checkout path (same
        logging/flagging as a standalone checkout). Draws that fail (box gone,
        already delivered) are reported but don't abort the rest. If the total
        delivered comes up short of the requested quantity, `note` is required
        so the requester learns why.
        """
        note = (note or "").strip()
        ts = _now()
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM requests WHERE id=?", (req_id,)).fetchone()
            if row is None:
                return {"ok": False, "message": f"Request #{req_id} not found."}
            if row["status"] not in (REQUEST_PENDING, REQUEST_STAGING):
                return {"ok": False,
                        "message": (f"Request #{req_id} is already "
                                    f"{row['status']}.")}

            results, delivered_total = [], 0
            for d in draws or []:
                epc = str(d.get("epc") or "").strip()
                if not epc:
                    continue
                result = self._deliver_units_locked(
                    epc, d.get("amount"), d.get("building"))
                results.append(result)
                if result.get("ok"):
                    delivered_total += result.get("delivered") or 0

            requested = row["quantity"]
            short = delivered_total < requested
            if delivered_total <= 0:
                self._conn.rollback()
                failed = "; ".join(r.get("message", "") for r in results)
                return {"ok": False,
                        "message": ("Nothing was delivered"
                                    + (f": {failed}" if failed else
                                       ": no boxes staged.")),
                        "results": results}
            if short and not note:
                self._conn.rollback()
                return {"ok": False, "note_required": True,
                        "message": (f"Only {delivered_total} of {requested} "
                                    "unit(s) supplied -- add a note for the "
                                    "requester explaining the shortfall."),
                        "results": []}

            handler_note = note
            if short:
                handler_note = (f"{delivered_total} of {requested} supplied"
                                + (f" -- {note}" if note else ""))
            self._conn.execute(
                "UPDATE requests SET status=?, handled_at=?, handler_note=?, "
                "status_dirty=1 WHERE id=?",
                (REQUEST_FULFILLED, ts, handler_note, req_id))
            boxes = sum(1 for r in results if r.get("ok"))
            label = row["item_type"] + (
                f" | {row['item_name']}" if row["item_name"] else "")
            self._log("REQUEST_FULFILLED", "", row["item_type"],
                      building=row["building"],
                      detail=(f"#{req_id}: {delivered_total} of {requested} x "
                              f"{label} from {boxes} box(es)"
                              + (f" -- {note}" if note else "")))
            self._conn.commit()
            updated = self._conn.execute(
                "SELECT * FROM requests WHERE id=?", (req_id,)).fetchone()

        return {"ok": True,
                "message": (f"Request #{req_id} fulfilled: {delivered_total} "
                            f"of {requested} unit(s) delivered."),
                "delivered": delivered_total, "requested": requested,
                "short": short, "results": results,
                "request": self._request_dict(updated)}

    def dirty_request_statuses(self):
        """Handled requests whose status the cloud hasn't acked yet."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM requests WHERE status_dirty=1").fetchall()
        return [{"id": r["id"], "status": r["status"],
                 "handled_at": r["handled_at"],
                 "handler_note": r["handler_note"]} for r in rows]

    def clear_request_dirty(self, ids):
        """Ack from the cloud: stop re-pushing these request statuses."""
        ids = [int(i) for i in ids or []]
        if not ids:
            return
        with self._lock:
            self._conn.execute(
                "UPDATE requests SET status_dirty=0 WHERE id IN (%s)"
                % ",".join("?" * len(ids)), ids)
            self._conn.commit()

    def close(self):
        with self._lock:
            self._conn.close()
