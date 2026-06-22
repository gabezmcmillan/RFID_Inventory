"""
Google Sheets backend for the RFID inventory web app (shipment model).

Worksheet layout (auto-created / header-backfilled if missing):
  WH Inventory:  Building | Item Name | Item Number | PO Number | Vendor | Qty |
                 Warehouse Status | Received Date | Delivered to Site Date | Value | Notes
                 ^ the main view. ONE row per shipment, keyed by
                   (Item Name + PO Number + Building). Qty = tags received.
  Tags:          EPC | Item Name | PO Number | Building | Vendor | Status |
                 Received At | Last Updated
                 ^ behind-the-scenes mapping so a scanned tag resolves to its
                   shipment and can't be double-counted.
  Log:           Timestamp | Action | EPC | Item Name | PO Number | Building | Vendor

Flow:
  Check In  (receive shipment): sweep the shipment's tags. New tags are added to
            Tags and the matching WH Inventory row's Qty is increased (created if
            new), Received Date stamped, Warehouse Status = "In Warehouse".
  Check Out (deliver to site):  scan a tag -> find its shipment row, Qty -1, stamp
            "Delivered to Site Date", set Warehouse Status = "Delivered" at Qty 0.
"""

from datetime import datetime

import gspread

import config

WH_INVENTORY = "WH Inventory"
TAGS = "Tags"
LOG = "Log"

STATUS_IN = "In Warehouse"
STATUS_DELIVERED = "Delivered"


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _today():
    return datetime.now().strftime("%m/%d/%Y")


def _to_int(value):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


class SheetsClient:
    def __init__(self):
        self.wh_headers = [
            "Building", "Item Name", "Item Number", "PO Number", "Vendor", "Qty",
            "Warehouse Status", "Received Date", "Delivered to Site Date",
            "Value", "Notes",
        ]
        self.tags_headers = [
            "EPC", "Item Name", "PO Number", "Building", "Vendor", "Status",
            "Received At", "Last Updated",
        ]
        self.log_headers = [
            "Timestamp", "Action", "EPC", "Item Name", "PO Number", "Building", "Vendor",
        ]

        gc = gspread.service_account(filename=config.CREDENTIALS_FILE)
        self.ss = gc.open(config.SPREADSHEET_NAME)

        self.wh_ws = self._ensure_tab(WH_INVENTORY, self.wh_headers)
        self.tags_ws = self._ensure_tab(TAGS, self.tags_headers)
        self.log_ws = self._ensure_tab(LOG, self.log_headers)

        # Cache the actual column order of each sheet so we build rows that line
        # up even if the live header order differs from the defaults above.
        self.wh_cols = self.wh_ws.row_values(1)
        self.tags_cols = self.tags_ws.row_values(1)
        self.log_cols = self.log_ws.row_values(1)

    # -- setup ---------------------------------------------------------------
    def _ensure_tab(self, title, headers):
        try:
            ws = self.ss.worksheet(title)
        except gspread.WorksheetNotFound:
            return self._create_tab(title, headers)

        first = [c.strip() for c in ws.row_values(1)]
        if not any(first):
            ws.update(range_name="A1", values=[headers], value_input_option="RAW")
            return ws
        if first != [h.strip() for h in headers]:
            # Tab exists with outdated headers (e.g. from a previous schema).
            # Preserve the old data under a legacy name and start fresh so the
            # current column layout is correct.
            self._rename_to_legacy(ws, title)
            return self._create_tab(title, headers)
        return ws

    def _create_tab(self, title, headers):
        ws = self.ss.add_worksheet(title=title, rows=2000, cols=max(len(headers), 11))
        ws.update(range_name="A1", values=[headers], value_input_option="RAW")
        return ws

    def _rename_to_legacy(self, ws, title):
        legacy = f"{title} (legacy)"
        suffix = 2
        existing = {w.title for w in self.ss.worksheets()}
        while legacy in existing:
            legacy = f"{title} (legacy {suffix})"
            suffix += 1
        ws.update_title(legacy)

    # -- row / column helpers ------------------------------------------------
    @staticmethod
    def _colmap(cols):
        return {name.strip(): i for i, name in enumerate(cols) if name.strip()}

    @staticmethod
    def _row(cols, data):
        """Build a row list matching `cols` from a {column_name: value} dict."""
        return [data.get(name.strip(), "") for name in cols]

    # -- reads ---------------------------------------------------------------
    def load_tags(self):
        """Return {EPC: {item_name, po_number, building, vendor, status, row}}."""
        tags = {}
        rows = self.tags_ws.get_all_values()
        if not rows:
            return tags
        col = self._colmap(rows[0])

        def get(row, name):
            i = col.get(name)
            return row[i].strip() if i is not None and i < len(row) else ""

        for rownum, row in enumerate(rows[1:], start=2):
            if not row or not row[0].strip():
                continue
            epc = row[0].strip().upper()
            tags[epc] = {
                "epc": epc,
                "item_name": get(row, "Item Name"),
                "po_number": get(row, "PO Number"),
                "building": get(row, "Building"),
                "vendor": get(row, "Vendor"),
                "status": (get(row, "Status") or STATUS_IN).strip(),
                "row": rownum,
            }
        return tags

    def _find_shipment_row(self, item_name, po_number, building):
        """Return (rownum, row_values, colmap) for a WH Inventory shipment, or
        (None, None, colmap)."""
        rows = self.wh_ws.get_all_values()
        col = self._colmap(rows[0]) if rows else self._colmap(self.wh_cols)
        ci, cp, cb = col.get("Item Name"), col.get("PO Number"), col.get("Building")

        def g(row, idx):
            return row[idx].strip() if idx is not None and idx < len(row) else ""

        for rownum, row in enumerate(rows[1:], start=2):
            if (g(row, ci) == item_name and g(row, cp) == po_number
                    and g(row, cb) == building):
                return rownum, row, col
        return None, None, col

    # -- writes --------------------------------------------------------------
    def _log(self, action, epc, item_name, po_number="", building="", vendor=""):
        row = self._row(self.log_cols, {
            "Timestamp": _now(), "Action": action, "EPC": epc,
            "Item Name": item_name, "PO Number": po_number,
            "Building": building, "Vendor": vendor,
        })
        self.log_ws.append_row(row, value_input_option="RAW")

    def receive_shipment(self, epcs, item_type, building, po_number, vendor):
        """Check In: record a shipment's tags and bump its WH Inventory Qty.

        Returns a result dict for the UI.
        """
        ts = _now()
        received = _today()
        tags = self.load_tags()

        ordered = list(dict.fromkeys(e.upper() for e in epcs))
        new_epcs = [e for e in ordered if e not in tags]
        duplicates = [e for e in ordered if e in tags]

        tag_rows = [
            self._row(self.tags_cols, {
                "EPC": epc, "Item Name": item_type, "PO Number": po_number,
                "Building": building, "Vendor": vendor, "Status": STATUS_IN,
                "Received At": ts, "Last Updated": ts,
            })
            for epc in new_epcs
        ]
        if tag_rows:
            self.tags_ws.append_rows(tag_rows, value_input_option="RAW")
        for epc in new_epcs:
            self._log("IN", epc, item_type, po_number, building, vendor)

        added = len(new_epcs)
        rownum, row, col = self._find_shipment_row(item_type, po_number, building)
        if rownum:
            qty_col = col["Qty"]
            new_qty = _to_int(row[qty_col] if qty_col < len(row) else 0) + added
            self.wh_ws.update_cell(rownum, qty_col + 1, new_qty)
            self.wh_ws.update_cell(rownum, col["Warehouse Status"] + 1, STATUS_IN)
        else:
            new_qty = added
            self.wh_ws.append_row(
                self._row(self.wh_cols, {
                    "Building": building, "Item Name": item_type, "Item Number": "",
                    "PO Number": po_number, "Vendor": vendor, "Qty": added,
                    "Warehouse Status": STATUS_IN, "Received Date": received,
                    "Delivered to Site Date": "", "Value": "", "Notes": "",
                }),
                # RAW so identity columns (Building / PO Number) keep leading zeros
                # and match on later scans; USER_ENTERED would coerce "07" -> 7.
                value_input_option="RAW",
            )

        msg = f"Received {added} {item_type} (PO {po_number or 'n/a'}, {building or 'n/a'})."
        if duplicates:
            msg += f" {len(duplicates)} already on file."
        return {"ok": True, "message": msg, "added": added,
                "duplicates": duplicates, "qty": new_qty, "item_type": item_type,
                "po_number": po_number, "building": building, "vendor": vendor}

    def deliver_to_site(self, epc):
        """Check Out: mark a tag delivered and decrement its shipment Qty."""
        epc = epc.upper()
        ts = _now()
        delivered = _today()
        tag = self.load_tags().get(epc)

        if tag is None:
            self._log("OUT", epc, "UNKNOWN")
            return {"ok": False, "message": f"{epc} is not registered.", "epc": epc}

        if tag["status"] == STATUS_DELIVERED:
            return {"ok": False,
                    "message": f"{tag['item_name']} ({epc}) is already delivered.",
                    "epc": epc, "item_type": tag["item_name"]}

        tcol = self._colmap(self.tags_cols)
        self.tags_ws.update_cell(tag["row"], tcol["Status"] + 1, STATUS_DELIVERED)
        self.tags_ws.update_cell(tag["row"], tcol["Last Updated"] + 1, ts)
        self._log("OUT", epc, tag["item_name"], tag["po_number"],
                  tag["building"], tag["vendor"])

        qty_remaining = None
        rownum, row, col = self._find_shipment_row(
            tag["item_name"], tag["po_number"], tag["building"])
        if rownum:
            qty_col = col["Qty"]
            qty_remaining = max(0, _to_int(row[qty_col] if qty_col < len(row) else 0) - 1)
            self.wh_ws.update_cell(rownum, qty_col + 1, qty_remaining)
            self.wh_ws.update_cell(rownum, col["Delivered to Site Date"] + 1, delivered)
            self.wh_ws.update_cell(
                rownum, col["Warehouse Status"] + 1,
                STATUS_DELIVERED if qty_remaining == 0 else STATUS_IN)

        return {"ok": True,
                "message": f"Delivered {tag['item_name']} ({epc}) to site.",
                "epc": epc, "item_type": tag["item_name"],
                "po_number": tag["po_number"], "building": tag["building"],
                "delivered_at": delivered, "qty_remaining": qty_remaining}

    def record_inventory(self, epcs, tags_by_epc=None):
        """Inventory sweep: report tags present, grouped by item type.

        Does not overwrite shipment quantities (a partial sweep should never zero
        out shipments it didn't cover); it logs COUNT rows for the audit trail.
        """
        if tags_by_epc is None:
            tags_by_epc = self.load_tags()

        counts, unknown = {}, []
        for epc in sorted(set(e.upper() for e in epcs)):
            tag = tags_by_epc.get(epc)
            if tag:
                counts[tag["item_name"]] = counts.get(tag["item_name"], 0) + 1
                self._log("COUNT", epc, tag["item_name"], tag["po_number"],
                          tag["building"], tag["vendor"])
            else:
                unknown.append(epc)
                self._log("COUNT", epc, "UNKNOWN")

        return {"counts": counts, "unknown": unknown,
                "total": sum(counts.values()) + len(unknown)}
