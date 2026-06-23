"""
SQLite backend for the RFID inventory web app (shipment model, local store).

This replaces the Google Sheets backend. The `tags` table is the single source
of truth: one row per physical EPC. A "shipment" / warehouse-inventory row is a
derived aggregation over tags grouped by (item_type, po_number, building), so
quantities are always a COUNT and can never drift out of sync.

Tables (created on first run):
  tags    EPC -> item_type, PO#, Building#, Vendor, SKU, mfc date, status,
          received_at, delivered_at. One row per physical tag.
  events  Append-only audit log (IN / OUT / COUNT).

Public API mirrors the old SheetsClient so app.py is a drop-in swap:
  receive_shipment(epcs, item_type, building, po_number, vendor, item_fields)
  deliver_to_site(epc)
  record_inventory(epcs)
Plus read helpers for the interactive inventory view and finder:
  inventory_tree(group_by), group_tags(item_type, group_by, value), find_tag(epc)
"""

import sqlite3
import threading
from datetime import datetime

import config

STATUS_IN = "In Warehouse"
STATUS_DELIVERED = "Delivered"
STATUS_PARTIAL = "Partial"

# group_by accepts these UI dimensions, mapped to tag columns.
GROUP_COLUMNS = {"po": "po_number", "building": "building"}


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
                    po_number    TEXT NOT NULL DEFAULT '',
                    building     TEXT NOT NULL DEFAULT '',
                    vendor       TEXT NOT NULL DEFAULT '',
                    sku          TEXT NOT NULL DEFAULT '',
                    mfc_date     TEXT NOT NULL DEFAULT '',
                    status       TEXT NOT NULL DEFAULT 'In Warehouse',
                    received_at  TEXT NOT NULL,
                    delivered_at TEXT NOT NULL DEFAULT '',
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
                    po_number TEXT,
                    building  TEXT,
                    vendor    TEXT,
                    detail    TEXT
                );
                CREATE TABLE IF NOT EXISTS vendors (
                    name TEXT PRIMARY KEY
                );
                CREATE INDEX IF NOT EXISTS idx_tags_group
                    ON tags (item_type, po_number, building);
                CREATE INDEX IF NOT EXISTS idx_tags_status ON tags (status);
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
        have = {row["name"] for row in
                self._conn.execute("PRAGMA table_info(tags)").fetchall()}
        for col in ("flag", "flagged_at"):
            if col not in have:
                self._conn.execute(
                    f"ALTER TABLE tags ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")

    # -- internals -----------------------------------------------------------
    def _log(self, action, epc, item_type="", po_number="", building="",
             vendor="", detail=""):
        self._conn.execute(
            "INSERT INTO events (ts, action, epc, item_type, po_number, "
            "building, vendor, detail) VALUES (?,?,?,?,?,?,?,?)",
            (_now(), action, epc, item_type, po_number, building, vendor, detail),
        )

    def _group_in_warehouse_qty(self, item_type, po_number, building):
        row = self._conn.execute(
            "SELECT COUNT(*) AS n FROM tags WHERE item_type=? AND po_number=? "
            "AND building=? AND status=?",
            (item_type, po_number, building, STATUS_IN),
        ).fetchone()
        return row["n"] if row else 0

    @staticmethod
    def _tag_dict(row):
        return {
            "epc": row["epc"],
            "item_type": row["item_type"],
            "po_number": row["po_number"],
            "building": row["building"],
            "vendor": row["vendor"],
            "sku": row["sku"],
            "mfc_date": row["mfc_date"],
            "status": row["status"],
            "received_at": row["received_at"],
            "delivered_at": row["delivered_at"],
            "flag": row["flag"],
            "flagged_at": row["flagged_at"],
        }

    # -- writes --------------------------------------------------------------
    def receive_shipment(self, epcs, item_type, building, po_number, vendor,
                         item_fields=None):
        """Check In: record a shipment's tags and report the group's quantity."""
        item_fields = item_fields or {}
        sku = (item_fields.get("sku") or "").strip()
        mfc_date = (item_fields.get("mfc_date") or "").strip()
        ts = _now()

        ordered = list(dict.fromkeys(e.upper() for e in epcs))
        added, duplicates = 0, []

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
                    "INSERT INTO tags (epc, item_type, po_number, building, "
                    "vendor, sku, mfc_date, status, received_at, delivered_at, "
                    "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (epc, item_type, po_number, building, vendor, sku, mfc_date,
                     STATUS_IN, ts, "", ts, ts),
                )
                self._log("IN", epc, item_type, po_number, building, vendor)
                added += 1

            qty = self._group_in_warehouse_qty(item_type, po_number, building)
            self._conn.commit()

        msg = f"Received {added} {item_type} (PO {po_number or 'n/a'}, {building or 'n/a'})."
        if duplicates:
            msg += f" {len(duplicates)} already on file."
        return {"ok": True, "message": msg, "added": added,
                "duplicates": duplicates, "qty": qty, "item_type": item_type,
                "po_number": po_number, "building": building, "vendor": vendor,
                "sku": sku, "mfc_date": mfc_date}

    def deliver_to_site(self, epc):
        """Check Out: mark a tag delivered and report the group's remaining qty."""
        epc = epc.upper()
        ts = _now()
        delivered = _today()

        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM tags WHERE epc=?", (epc,)).fetchone()

            if row is None:
                self._log("OUT", epc, "UNKNOWN", detail="not registered")
                self._conn.commit()
                return {"ok": False, "message": f"{epc} is not registered.",
                        "epc": epc}

            if row["status"] == STATUS_DELIVERED:
                return {"ok": False,
                        "message": f"{row['item_type']} ({epc}) is already delivered.",
                        "epc": epc, "item_type": row["item_type"]}

            self._conn.execute(
                "UPDATE tags SET status=?, delivered_at=?, updated_at=? WHERE epc=?",
                (STATUS_DELIVERED, ts, ts, epc),
            )
            self._log("OUT", epc, row["item_type"], row["po_number"],
                      row["building"], row["vendor"])
            qty_remaining = self._group_in_warehouse_qty(
                row["item_type"], row["po_number"], row["building"])
            self._conn.commit()

        return {"ok": True,
                "message": f"Delivered {row['item_type']} ({epc}) to site.",
                "epc": epc, "item_type": row["item_type"],
                "po_number": row["po_number"], "building": row["building"],
                "delivered_at": delivered, "qty_remaining": qty_remaining}

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
                if row["status"] == STATUS_DELIVERED:
                    flag = (f"Checked out {_date_of(row['delivered_at'])}; "
                            "detected in sweep")
                    self._conn.execute(
                        "UPDATE tags SET flag=?, flagged_at=?, updated_at=? WHERE epc=?",
                        (flag, ts, ts, epc))
                    self._log("FLAG", epc, row["item_type"], row["po_number"],
                              row["building"], row["vendor"], detail=flag)
                    flagged.append({
                        "epc": epc, "item_type": row["item_type"],
                        "po_number": row["po_number"], "building": row["building"],
                        "delivered_at": _date_of(row["delivered_at"]), "flag": flag,
                    })
                else:
                    counts[row["item_type"]] = counts.get(row["item_type"], 0) + 1
                    self._log("COUNT", epc, row["item_type"], row["po_number"],
                              row["building"], row["vendor"])
            self._conn.commit()

        return {"counts": counts, "unknown": unknown, "flagged": flagged,
                "items": items,
                "total": sum(counts.values()) + len(unknown) + len(flagged)}

    # -- reads (interactive inventory view) ----------------------------------
    def inventory_tree(self, group_by="po"):
        """Nested view: item type -> groups (by PO# or Building#) with qty/status.

        Only counts tags still in the warehouse; a group whose tags are all
        delivered drops to qty 0 and status Delivered.
        """
        gcol = GROUP_COLUMNS.get(group_by, "po_number")
        with self._lock:
            rows = self._conn.execute(
                f"""
                SELECT item_type,
                       {gcol}                              AS gval,
                       SUM(status = ?)                     AS in_wh,
                       COUNT(*)                            AS total,
                       MIN(received_at)                    AS first_received
                FROM tags
                GROUP BY item_type, {gcol}
                ORDER BY item_type, gval
                """,
                (STATUS_IN,),
            ).fetchall()

        types = {}
        for r in rows:
            t = types.setdefault(r["item_type"], {"item_type": r["item_type"],
                                                  "qty": 0, "groups": []})
            qty = r["in_wh"] or 0
            total = r["total"]
            t["qty"] += qty
            if qty == 0:
                status = STATUS_DELIVERED
            elif qty == total:
                status = STATUS_IN
            else:
                status = STATUS_PARTIAL
            t["groups"].append({
                "value": r["gval"] or "",
                "qty": qty,
                "in_wh": qty,
                "total": total,
                "received": _date_of(r["first_received"]),
                "received_at": r["first_received"] or "",
                "status": status,
            })
        return {"group_by": group_by, "types": list(types.values())}

    def group_tags(self, item_type, group_by, value):
        """Individual tags within one (item_type, group) cell, for drill-down."""
        gcol = GROUP_COLUMNS.get(group_by, "po_number")
        with self._lock:
            rows = self._conn.execute(
                f"SELECT * FROM tags WHERE item_type=? AND {gcol}=? "
                "ORDER BY received_at, epc",
                (item_type, value),
            ).fetchall()
        return {"item_type": item_type, "group_by": group_by, "value": value,
                "tags": [self._tag_dict(r) for r in rows]}

    def find_tag(self, epc):
        """Return a single tag dict (for the finder) or None."""
        epc = epc.upper()
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM tags WHERE epc=?", (epc,)).fetchone()
        return self._tag_dict(row) if row else None

    # -- admin ---------------------------------------------------------------
    def clear_all(self):
        """Delete every tag. Events are kept as an audit trail (plus a CLEAR)."""
        with self._lock:
            removed = self._conn.execute(
                "SELECT COUNT(*) AS n FROM tags").fetchone()["n"]
            self._conn.execute("DELETE FROM tags")
            self._log("CLEAR", "", detail=f"cleared {removed} tag(s)")
            self._conn.commit()
        return {"ok": True, "removed": removed,
                "message": f"Cleared {removed} tag(s) from the database."}

    # Fields an admin may edit on a tag.
    EDITABLE = ("item_type", "po_number", "building", "vendor", "sku",
                "mfc_date", "status")

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
            for key in self.EDITABLE:
                if key in fields:
                    new_val = ("" if fields[key] is None else str(fields[key])).strip()
                    if new_val != (row[key] or ""):
                        sets.append(f"{key}=?")
                        params.append(new_val)
                        changes.append(f"{key}: '{row[key]}' -> '{new_val}'")

            # Keep delivered_at / flag consistent with a status change.
            if "status" in fields:
                if fields["status"] == STATUS_IN:
                    sets += ["delivered_at=?", "flag=?", "flagged_at=?"]
                    params += ["", "", ""]
                elif fields["status"] == STATUS_DELIVERED and not row["delivered_at"]:
                    sets.append("delivered_at=?")
                    params.append(ts)

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

    def close(self):
        with self._lock:
            self._conn.close()
