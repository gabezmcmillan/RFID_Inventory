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

# TSL Alert command (`.al`) used by the finder to buzz/vibrate the handheld once
# the target tag is locked. Params: -b buzzer on/off, -v vibrate on/off,
# -d sho/med/lon duration; an `.al` without -n fires immediately (both off errors).
# We fire a long vibrate (buzzer off), then restore the defaults *without* firing
# (-n) so the normal read-success beep in other modes is unaffected.
ALERT_VIBRATE_CMD = ".al -boff -von -dlon"      # fire: long vibrate, no buzzer
ALERT_RESTORE_CMD = ".al -bon -dsho -von -n"    # restore defaults, no action

# Finder: map the reader's RSSI (dBm) to an absolute 0-100% signal strength so
# the bar/tone use a stable scale instead of an adaptive one. Tune to taste:
# raise MAX toward -35 if 100% is too easy to hit, lower MIN if the bar never
# leaves 0% at a distance.
FINDER_RSSI_MIN_DBM = -80   # this dBm (or weaker) maps to 0%
FINDER_RSSI_MAX_DBM = -40   # this dBm (or stronger) maps to 100%

# ---------------------------------------------------------------------------
# Local database (SQLite)
# ---------------------------------------------------------------------------
DB_PATH = "inventory.db"

# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
# PIN required for admin actions (clear database, edit records). This is light
# protection for a trusted local machine, not real security -- change it here.
ADMIN_PIN = "1234"

# ---------------------------------------------------------------------------
# Web server
# ---------------------------------------------------------------------------
HOST = "127.0.0.1"
PORT = 8000

# ---------------------------------------------------------------------------
# Item types and check-in fields
# ---------------------------------------------------------------------------
# A check-in registers a shipment of an item type and tags each physical unit.
# Fields carry a `scope`:
#   "shipment" : entered once when arming the shipment, applied to every tag
#                in it (Building #, PO Number, Vendor).
#   "item"     : entered per unit, just before pulling the trigger on that tag
#                (SKU, Manufactured Date) -- each tag can differ.
# Each field: key (stored), label (shown in UI), type (input type), scope.
# Building # is a fixed set of buttons (edit here to change the choices). Vendor
# is a dropdown whose options live in the DB and are managed in the Admin view;
# DEFAULT_VENDORS seeds the list on first run only.
BUILDING_OPTIONS = ["6", "7", "8"]
DEFAULT_VENDORS = []

SHIPMENT_FIELDS = [
    {"key": "building_number", "label": "Building #", "type": "buttons",
     "options": BUILDING_OPTIONS, "scope": "shipment"},
    {"key": "po_number",       "label": "PO Number",  "type": "text",   "scope": "shipment"},
    {"key": "vendor",          "label": "Vendor",     "type": "select", "scope": "shipment"},
]
ITEM_FIELDS = [
    {"key": "sku",      "label": "SKU",               "type": "text",   "scope": "item"},
    {"key": "mfc_date", "label": "Manufactured Date", "type": "date",   "scope": "item"},
    {"key": "quantity", "label": "Quantity (units in this box)", "type": "number",
     "scope": "item"},
]
COMMON_FIELDS = SHIPMENT_FIELDS + ITEM_FIELDS

# Item types double as the "Item Name" in the database.
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
