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
# Label printer (Zebra ZD621R, raw ZPL over USB or TCP -- see printer.py)
# ---------------------------------------------------------------------------
# Check-in can print + RFID-encode a 4x6 label for each box. Two transports;
# set exactly one per machine in settings.ini (leave both empty to turn the
# feature off -- the Print button is hidden):
#   PRINTER_QUEUE : Windows print-queue name of a USB-attached printer (as
#                   shown in Settings > Printers, e.g. "ZDesigner ZD621R-300dpi
#                   ZPL"). ZPL is sent through the spooler as a RAW job, so
#                   the driver passes it through unrendered. Windows-only;
#                   takes precedence over PRINTER_HOST when both are set.
#   PRINTER_HOST  : printer's IP on the warehouse LAN, raw ZPL over TCP 9100.
PRINTER_QUEUE = ""           # e.g. "ZDesigner ZD621R-300dpi ZPL"
PRINTER_HOST = ""            # e.g. "10.1.57.18"
PRINTER_PORT = 9100          # Zebra raw-ZPL port; effectively never changes
# Prefix of app-minted EPCs (hex: "42473031" is ASCII "BG01"); the remaining
# 16 hex digits are a serial allocated by the local DB. Factory-encoded tags
# checked in via the handheld keep whatever EPC they came with.
PRINTER_EPC_PREFIX = "42473031"

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
# Cloud sync (see sync.py and cloud/)
# ---------------------------------------------------------------------------
# The .exe keeps working entirely offline; when CLOUD_URL is set, a background
# worker pushes inventory to the cloud app and pulls material requests every
# SYNC_INTERVAL_SECONDS. Leave CLOUD_URL empty to run without a cloud at all.
# These are normally set per machine in settings.ini, not here.
CLOUD_URL = ""            # e.g. "https://switch-warehouse.brasfieldgorrie.com"
SYNC_TOKEN = ""           # bearer token; must match the cloud app's SYNC_TOKEN
SYNC_ENABLED = True       # master switch (only matters when CLOUD_URL is set)
SYNC_INTERVAL_SECONDS = 30

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
    PRINTER_QUEUE = (_s.get("printer_queue", PRINTER_QUEUE).strip()
                     or PRINTER_QUEUE)
    PRINTER_HOST = _s.get("printer_host", PRINTER_HOST).strip() or PRINTER_HOST
    PRINTER_PORT = _s.getint("printer_port", fallback=PRINTER_PORT)
    ADMIN_PIN = _s.get("admin_pin", ADMIN_PIN).strip() or ADMIN_PIN
    HOST = _s.get("host", HOST).strip() or HOST
    PORT = _s.getint("port", fallback=PORT)
    CLOUD_URL = _s.get("cloud_url", CLOUD_URL).strip() or CLOUD_URL
    SYNC_TOKEN = _s.get("sync_token", SYNC_TOKEN).strip() or SYNC_TOKEN
    SYNC_ENABLED = _s.getboolean("sync_enabled", fallback=SYNC_ENABLED)
    SYNC_INTERVAL_SECONDS = _s.getint("sync_interval_seconds",
                                      fallback=SYNC_INTERVAL_SECONDS)

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
    {"key": "sector",          "label": "Sector",     "type": "text",   "scope": "shipment"},
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

# W.I.F. (White Iron Forest) is a family of structural components, so each
# box also carries the component's name. `suggest` makes the UI offer
# previously used names as autocomplete options.
ITEM_NAME_FIELD = {"key": "item_name", "label": "Item Name", "type": "text",
                   "scope": "item", "suggest": True}

# Types whose boxes carry a per-unit item_name (component name). These group
# by item_name in the warehouse view and print "TYPE | name" on labels.
NAMED_ITEM_TYPES = ["W.I.F."]

# Every type shares COMMON_FIELDS; named types add the Item Name field ahead
# of the other per-unit fields.
TYPE_FIELDS = {
    item_type: (SHIPMENT_FIELDS + [ITEM_NAME_FIELD] + ITEM_FIELDS
                if item_type in NAMED_ITEM_TYPES else COMMON_FIELDS)
    for item_type in ITEM_TYPES
}


def all_field_defs():
    """Ordered, de-duplicated list of every field used across all types.

    Used to build a single stable column layout for the Items worksheet.
    """
    seen = {}
    for fields in TYPE_FIELDS.values():
        for field in fields:
            seen.setdefault(field["key"], field)
    return list(seen.values())
