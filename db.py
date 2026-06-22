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
                CREATE INDEX IF NOT EXISTS idx_tags_group
                    ON tags (item_type, po_number, building);
                CREATE INDEX IF NOT EXISTS idx_tags_status ON tags (status);
                """
            )
            self._conn.commit()

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
        shipments it didn't cover); it logs COUNT rows for the audit trail.
        """
        counts, unknown = {}, []
        with self._lock:
            for epc in sorted(set(e.upper() for e in epcs)):
                row = self._conn.execute(
                    "SELECT item_type, po_number, building, vendor FROM tags "
                    "WHERE epc=?", (epc,)).fetchone()
                if row:
                    counts[row["item_type"]] = counts.get(row["item_type"], 0) + 1
                    self._log("COUNT", epc, row["item_type"], row["po_number"],
                              row["building"], row["vendor"])
                else:
                    unknown.append(epc)
                    self._log("COUNT", epc, "UNKNOWN")
            self._conn.commit()

        return {"counts": counts, "unknown": unknown,
                "total": sum(counts.values()) + len(unknown)}

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
            t["qty"] += qty
            t["groups"].append({
                "value": r["gval"] or "",
                "qty": qty,
                "total": r["total"],
                "received": _date_of(r["first_received"]),
                "status": STATUS_IN if qty > 0 else STATUS_DELIVERED,
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

    def close(self):
        with self._lock:
            self._conn.close()
