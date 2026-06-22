"""
Shared configuration for the RFID inventory web app.

Edit the hardware/connection values for your machine. The item-type and field
definitions drive both the Google Sheets schema and the browser form, so adding
a new type or field here automatically flows through the whole app.
"""

# ---------------------------------------------------------------------------
# Reader / serial connection
# ---------------------------------------------------------------------------
SERIAL_PORT    = "/dev/cu.usbserial-1128_US_V01336"  # USB port for the TSL/Vulcan reader
BAUD_RATE      = 115200
SERIAL_TIMEOUT = 0.3        # seconds per readline()

# A scan "burst" is considered finished once this many seconds pass with no new
# EP:/OK: lines from the reader (i.e. the trigger has been released).
QUIET_GAP_SECONDS = 0.6

# Reader output power (TSL `.iv -o<nn>`, dBm, valid range 10-29). dBm is
# logarithmic, so lower values sharply reduce read range. We set a low power for
# check-in/check-out so only the tag held right at the reader is read (avoids
# stray EPCs), and full power for inventory sweeps (unknown EPCs are ignored).
READER_POWER_MIN_DBM = 10
READER_POWER_MAX_DBM = 29


def power_from_percent(pct):
    """Map a 0-100% strength to a dBm value within the reader's range."""
    pct = max(0, min(100, pct))
    span = READER_POWER_MAX_DBM - READER_POWER_MIN_DBM
    return round(READER_POWER_MIN_DBM + (pct / 100.0) * span)


CHECK_POWER_DBM = power_from_percent(30)        # ~30% strength -> close-range only
INVENTORY_POWER_DBM = READER_POWER_MAX_DBM      # full power for sweeps

# ---------------------------------------------------------------------------
# Google Sheets
# ---------------------------------------------------------------------------
CREDENTIALS_FILE = "credentials.json"
SPREADSHEET_NAME = "RFID-TRACKING"

# ---------------------------------------------------------------------------
# Web server
# ---------------------------------------------------------------------------
HOST = "127.0.0.1"
PORT = 8000

# ---------------------------------------------------------------------------
# Item types and shipment fields
# ---------------------------------------------------------------------------
# A check-in registers a *shipment* of an item type. Each field below is shown
# in the check-in form and stored on the WH Inventory / Tags rows. The Received
# Date is auto-populated from the scan time, so it is not a form field.
# Each field: key (stored), label (shown in UI + sheet header), type (input type).
COMMON_FIELDS = [
    {"key": "building_number", "label": "Building #", "type": "text"},
    {"key": "po_number",       "label": "PO Number",  "type": "text"},
    {"key": "vendor",          "label": "Vendor",     "type": "text"},
]

# Item types double as the "Item Name" on the WH Inventory sheet.
ITEM_TYPES = ["TSC", "CDU", "W.I.F."]

# For now every type shares COMMON_FIELDS. To give a type unique fields later,
# replace its value with a custom list of field dicts.
TYPE_FIELDS = {item_type: COMMON_FIELDS for item_type in ITEM_TYPES}


def all_field_defs():
    """Ordered, de-duplicated list of every field used across all types.

    Used to build a single stable column layout for the Items worksheet.
    """
    seen = {}
    for fields in TYPE_FIELDS.values():
        for field in fields:
            seen.setdefault(field["key"], field)
    return list(seen.values())
