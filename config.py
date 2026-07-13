"""
Shared configuration for the RFID inventory web app.

Edit the hardware/connection values for your machine. The item-type and field
definitions drive both the Google Sheets schema and the browser form, so adding
a new type or field here automatically flows through the whole app.
"""

import configparser
import os
import sys

# ---------------------------------------------------------------------------
# Paths (source checkout vs. frozen .exe)
# ---------------------------------------------------------------------------
# Under PyInstaller, bundled read-only assets (static/) are unpacked to
# sys._MEIPASS, while persistent data (inventory.db, scans/, settings.ini)
# lives next to the executable so it survives rebuilds and is easy to find.
# Running from source, both point at this file's directory, so the app works
# no matter what directory it is launched from.
FROZEN = bool(getattr(sys, "frozen", False))
BASE_DIR = (os.path.dirname(sys.executable) if FROZEN
            else os.path.dirname(os.path.abspath(__file__)))
RESOURCE_DIR = getattr(sys, "_MEIPASS", BASE_DIR)
STATIC_DIR = os.path.join(RESOURCE_DIR, "static")

# ---------------------------------------------------------------------------
# Reader / serial connection
# ---------------------------------------------------------------------------
# Serial port of the TSL/Vulcan reader. "auto" scans the system's ports for the
# handheld (a name/description containing "1128", else the first FTDI device --
# see reader.resolve_port). Pin it explicitly if auto ever picks wrong:
#   macOS:   "/dev/cu.usbserial-1128_US_V01336"
#   Windows: "COM3"  (Device Manager > Ports (COM & LPT))
SERIAL_PORT    = "auto"
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


CHECK_POWER_DBM = READER_POWER_MIN_DBM          # lowest power -> tag at reader only
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
# Document scanner (Epson ES-50 via the NAPS2 CLI)
# ---------------------------------------------------------------------------
# Bill-of-lading scans are driven through NAPS2 (macOS: brew install --cask
# naps2; Windows: https://www.naps2.com download). On macOS the GUI binary
# doubles as the CLI via `NAPS2 console ...`; on Windows the CLI is the
# separate NAPS2.Console.exe next to the GUI exe.
IS_WINDOWS = sys.platform.startswith("win")

if IS_WINDOWS:
    _NAPS2_CANDIDATES = [
        os.path.expandvars(r"%ProgramFiles%\NAPS2\NAPS2.Console.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\NAPS2\NAPS2.Console.exe"),
        os.path.expandvars(r"%LocalAppData%\Programs\NAPS2\NAPS2.Console.exe"),
    ]
else:
    _NAPS2_CANDIDATES = [
        "/Applications/NAPS2.app/Contents/MacOS/NAPS2",
        os.path.expanduser("~/Applications/NAPS2.app/Contents/MacOS/NAPS2"),
    ]
NAPS2_BINARY = next((p for p in _NAPS2_CANDIDATES if os.path.exists(p)),
                    _NAPS2_CANDIDATES[0])
# macOS: NAPS2's bundled SANE backend (epsonds) drives the ES-50 over USB with
# no extra Epson driver install ("apple"/ImageCaptureCore would need Epson's
# ICA driver package). Windows: WIA works with the standard Epson driver.
SCANNER_DRIVER = "wia" if IS_WINDOWS else "sane"
SCANNER_DEVICE = "ES-50"     # partial, case-insensitive device-name match
SCAN_DPI = 300
SCAN_TIMEOUT_SECONDS = 120   # give up on a scan after this long
# BOL PDFs are stored here (filenames kept in the DB). Anchored to BASE_DIR so
# the folder sits next to the .exe when frozen / next to the code when not.
SCANS_DIR = os.path.join(BASE_DIR, "scans")

# OCR: NAPS2's built-in Tesseract runs on every scanned/uploaded BOL so the
# stored PDF gets a searchable text layer, from which BOL #, Vendor and PO #
# are auto-extracted (see bol_extract.py). Requires the one-time language
# component download: `NAPS2 console --install ocr-eng` (macOS) or
# `NAPS2.Console.exe --install ocr-eng` (Windows); the app also attempts this
# automatically at startup. If OCR is unavailable the scan flow still works,
# fields just aren't prefilled.
OCR_ENABLED = True
OCR_LANG = "eng"

# ---------------------------------------------------------------------------
# Local database (SQLite)
# ---------------------------------------------------------------------------
DB_PATH = os.path.join(BASE_DIR, "inventory.db")

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
# Per-machine overrides (settings.ini)
# ---------------------------------------------------------------------------
# A frozen .exe bakes this file in, so the handful of values that vary per
# machine can be overridden by an optional settings.ini next to the executable
# (or next to the code when running from source). Missing file/keys keep the
# defaults above.
_ini = configparser.ConfigParser()
if _ini.read(os.path.join(BASE_DIR, "settings.ini")) and "settings" in _ini:
    _s = _ini["settings"]
    SERIAL_PORT = _s.get("serial_port", SERIAL_PORT).strip() or SERIAL_PORT
    ADMIN_PIN = _s.get("admin_pin", ADMIN_PIN).strip() or ADMIN_PIN
    HOST = _s.get("host", HOST).strip() or HOST
    PORT = _s.getint("port", fallback=PORT)

# ---------------------------------------------------------------------------
# Item types and check-in fields
# ---------------------------------------------------------------------------
# A check-in registers a shipment of an item type and tags each physical unit.
# Fields carry a `scope`:
#   "shipment" : entered once when arming the shipment, applied to every tag
#                in it (Building #, BOL Number, Vendor).
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
    {"key": "bol_number",      "label": "BOL Number", "type": "text",   "scope": "shipment"},
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
