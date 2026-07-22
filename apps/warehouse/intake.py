"""
Shipment intake: the one place a box becomes inventory.

Check-in used to live in three places that could diverge -- the print
endpoint (mint -> print -> record), the reader worker (which carried the
shipment fields on its checkin_batch event), and the checkin_item endpoint
(which wrote per-unit fields into the reader). This module owns the whole
workflow; HTTP handlers and the reader event pump are thin adapters that
build a request and call it.

The armed shipment (item type + shipment-scope fields) and the per-unit
fields for the next tag live here, not on the reader: the reader emits only
the EPC it picked from a burst. Arm/scan/print calls come from different
threads (HTTP executor threads, the event pump's executor), so state is
guarded by a lock.

Two intake paths, one recording rule:
  check_in_scanned(epc)  - handheld path: a trigger pull (or the "test
                           without hardware" injector) picked one EPC.
  check_in_printed(...)  - print path: mint EPCs, print/encode labels, and
                           record ONLY the labels that actually printed, so
                           a dead printer never creates phantom inventory.
"""

import threading
from datetime import datetime

import config
import printer as printer_module


def _as_doc_id(value):
    """Coerce a fields-dict bol_doc_id (string) to an int, or None."""
    try:
        doc_id = int(str(value).strip())
        return doc_id if doc_id > 0 else None
    except (TypeError, ValueError):
        return None


# Operator-correctable per-unit fields (see amend()).
AMENDABLE_FIELDS = ("item_name", "sku", "mfc_date", "quantity")

MAX_LABELS_PER_PRINT = 25


class ShipmentIntake:
    def __init__(self, db, printer_mod=None):
        self.db = db
        self.printer = printer_mod if printer_mod is not None else printer_module
        self._lock = threading.Lock()
        self._armed = None       # {"item_type": ..., "fields": {...}} or None
        # Per-unit fields (Item No., mfc date) for the NEXT tag; the UI updates
        # these before each trigger pull since they differ per unit.
        self._item_fields = {}

    # -- armed shipment --------------------------------------------------------
    def arm(self, item_type, fields):
        """Arm check-in for a shipment; scanned tags file under these fields."""
        with self._lock:
            self._armed = {"item_type": item_type, "fields": dict(fields or {})}
            self._item_fields = {}

    def disarm(self):
        with self._lock:
            self._armed = None
            self._item_fields = {}

    def set_item_fields(self, fields):
        """Set the per-unit fields (Item No., mfc date) for the next tag."""
        with self._lock:
            self._item_fields = dict(fields or {})

    # -- handheld path -----------------------------------------------------------
    def check_in_scanned(self, epc):
        """Record one trigger-pull tag under the armed shipment."""
        with self._lock:
            armed = self._armed
            item_fields = dict(self._item_fields)
        if not armed:
            return {"ok": False,
                    "message": "No shipment armed for check-in."}
        return self._receive([epc], armed["item_type"], armed["fields"],
                             item_fields)

    # -- print path --------------------------------------------------------------
    def check_in_printed(self, item_type, fields, item_fields, count=1):
        """Check boxes in by printing + encoding fresh labels for them.

        The app mints the EPCs (db.allocate_epcs), the ZD621R burns each into
        the label's inlay while printing (printer.py). Labels are printed
        first and only the successfully sent ones are recorded, so a dead
        printer never creates phantom inventory.
        """
        if not self.printer.enabled():
            return {"ok": False,
                    "message": ("No label printer configured -- set "
                                "printer_queue or printer_host in "
                                "settings.ini")}
        count = max(1, min(count or 1, MAX_LABELS_PER_PRINT))
        fields = fields or {}
        item_fields = item_fields or {}
        # Named types (W.I.F.) print "TYPE | component name" as the description.
        item_name = (item_fields.get("item_name") or "").strip()
        description = f"{item_type} | {item_name}" if item_name else item_type
        now = datetime.now()

        epcs = self.db.allocate_epcs(count)
        # QR on the label opens the box's page on the cloud site (BOL PDF and
        # live status); printed only when this install has a cloud configured.
        cloud_base = config.CLOUD_URL.rstrip("/")
        printed, print_error = [], ""
        for epc in epcs:
            try:
                self.printer.print_label(
                    epc=epc,
                    building=fields.get("building_number", ""),
                    sector=fields.get("sector", ""),
                    description=description,
                    supplier=fields.get("vendor", ""),
                    sku=item_fields.get("sku", ""),
                    quantity=item_fields.get("quantity") or "1",
                    po_number=fields.get("po_number", ""),
                    received_date=now.strftime("%m/%d/%Y"),
                    received_time=now.strftime("%I:%M %p").lstrip("0"),
                    qr_url=f"{cloud_base}/tag/{epc}" if cloud_base else "")
                printed.append(epc)
            except printer_module.PrintError as exc:
                print_error = str(exc)
                break

        if not printed:
            return {"ok": False, "message": f"Label not printed: {print_error}"}

        result = self._receive(printed, item_type, fields, item_fields)
        result["printed"] = len(printed)
        if print_error:
            result["message"] += (f" Printing stopped after {len(printed)} of "
                                  f"{count} labels: {print_error}")
        return result

    # -- corrections ---------------------------------------------------------------
    def amend(self, epc, fields):
        """Operator fix of a just-checked-in tag (name / Item No. / mfc date / qty).

        Not PIN-gated: it corrects a typo right after the trigger pull,
        before the box has been touched.
        """
        allowed = {k: v for k, v in (fields or {}).items()
                   if k in AMENDABLE_FIELDS}
        return self.db.amend_checkin(epc, allowed)

    # -- shared recording ------------------------------------------------------------
    def _receive(self, epcs, item_type, fields, item_fields):
        return self.db.receive_shipment(
            epcs, item_type,
            fields.get("building_number", ""),
            fields.get("bol_number", ""),
            fields.get("vendor", ""),
            item_fields,
            _as_doc_id(fields.get("bol_doc_id")),
            fields.get("po_number", ""),
            fields.get("sector", ""))
