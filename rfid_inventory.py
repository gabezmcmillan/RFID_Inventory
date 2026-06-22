#!/usr/bin/env python3
"""
Barebones RFID inventory tool for the Vulcan RFID Indium (TSL ASCII 2.0 reader).

WHAT IT DOES
  - Connects to the handheld over a Bluetooth serial (SPP) COM port.
  - Enroll mode: register one tag's EPC -> SKU / item name (builds your mapping).
  - Count mode:  sweep an area, collect UNIQUE EPCs, and write a per-SKU count
                 to a Google Sheet, plus a timestamped log of what was seen.

WHY DEDUP MATTERS (UHF)
  UHF readers re-read the same tag dozens of times per second. We therefore never
  count raw reads -- we collect DISTINCT EPCs into a set. One unique EPC == one
  physical item, so a SKU's quantity == number of distinct EPCs seen for it.

GOOGLE SHEET LAYOUT (worksheets are auto-created if missing)
  Mapping:   EPC | SKU | Item Name | Registered At
  Inventory: SKU | Item Name | Quantity | Last Counted
  Log:       Timestamp | EPC | SKU

SETUP
  pip install pyserial gspread
  - Pair the reader in Windows Bluetooth settings; note the OUTGOING COM port
    it creates (Control Panel > Devices and Printers > reader > Hardware tab,
    or Device Manager > Ports). Put that in SERIAL_PORT below.
  - Put your Google service-account key next to this file as credentials.json
    and share the spreadsheet with that account's client_email.
"""

import time
import threading
from datetime import datetime

import serial      # pip install pyserial
import gspread     # pip install gspread

# ---------------------------------------------------------------------------
# CONFIG -- edit for your machine
# ---------------------------------------------------------------------------
SERIAL_PORT      = "/dev/cu.usbserial-1128_US_V01336"            # outgoing Bluetooth SPP port for the reader
BAUD_RATE        = 115200            # usually ignored over Bluetooth SPP
SERIAL_TIMEOUT   = 0.3               # seconds per readline()
SWEEP_SECONDS    = 8                 # how long a count sweep runs

CREDENTIALS_FILE = "credentials.json"
SPREADSHEET_NAME = "RFID-TRACKING"


# ---------------------------------------------------------------------------
# Google Sheets
# ---------------------------------------------------------------------------
def open_sheets():
    gc = gspread.service_account(filename=CREDENTIALS_FILE)
    ss = gc.open(SPREADSHEET_NAME)

    def ensure_tab(title, headers):
        try:
            return ss.worksheet(title)
        except gspread.WorksheetNotFound:
            ws = ss.add_worksheet(title=title, rows=2000, cols=len(headers))
            ws.append_row(headers)
            return ws

    mapping   = ensure_tab("Mapping",   ["EPC", "SKU", "Item Name", "Registered At"])
    inventory = ensure_tab("Inventory", ["SKU", "Item Name", "Quantity", "Last Counted"])
    log       = ensure_tab("Log",       ["Timestamp", "EPC", "SKU"])
    return mapping, inventory, log


def load_mapping(mapping_ws):
    """Return {EPC: (sku, item_name)} from the Mapping tab."""
    mapping = {}
    for row in mapping_ws.get_all_values()[1:]:        # skip header
        if row and row[0].strip():
            epc  = row[0].strip().upper()
            sku  = row[1].strip() if len(row) > 1 else ""
            name = row[2].strip() if len(row) > 2 else ""
            mapping[epc] = (sku, name)
    return mapping


def update_inventory(inventory_ws, counts, ts):
    """counts: {sku: [quantity, item_name]}. Overwrite each SKU's row for this session."""
    rows = inventory_ws.get_all_values()[1:]
    sku_to_rownum = {r[0].strip(): i + 2 for i, r in enumerate(rows) if r and r[0].strip()}
    appends = []
    for sku, (qty, name) in counts.items():
        if sku in sku_to_rownum:
            r = sku_to_rownum[sku]
            inventory_ws.update(range_name=f"A{r}:D{r}", values=[[sku, name, qty, ts]])
        else:
            appends.append([sku, name, qty, ts])
    if appends:
        inventory_ws.append_rows(appends)


# ---------------------------------------------------------------------------
# Reader (TSL ASCII 2.0)
# ---------------------------------------------------------------------------
def open_reader():
    ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=SERIAL_TIMEOUT)
    time.sleep(0.2)
    ser.reset_input_buffer()
    return ser


def inventory_cycle(ser, strongest_only=False):
    """
    Issue one .iv inventory and return the set of EPCs read this cycle.

    Response format (TSL ASCII 2.0):
        CS: .iv ...
        EP: 41524E4C3030303030310000
        EP: 330DE29525C0210005F5F8F2
        OK:
    We collect each value after an 'EP:' header until OK:/ER:.
    """
    cmd = ".iv -al on"                      # -al on => beep on success
    if strongest_only:
        cmd += " -fs on"                    # only the single strongest tag
    ser.write((cmd + "\r\n").encode())

    epcs = set()
    deadline = time.time() + 3.0            # per-cycle safety timeout
    while time.time() < deadline:
        raw = ser.readline()
        if not raw:
            continue
        line = raw.decode(errors="ignore").strip()
        if line.startswith("EP:"):
            epcs.add(line[3:].strip().upper())
        elif line.startswith(("OK:", "ER:")):
            break
    return epcs


# ---------------------------------------------------------------------------
# Workflows
# ---------------------------------------------------------------------------
def enroll(ser, mapping_ws, mapping):
    print("\n-- Enroll a tag --")
    input("Point the reader at ONE tag, then press Enter to scan...")
    epcs = inventory_cycle(ser, strongest_only=True)
    if not epcs:
        print("No tag read. Move closer and try again.")
        return
    epc = sorted(epcs)[0]
    if epc in mapping:
        sku, name = mapping[epc]
        print(f"Already registered: {epc} -> {sku} ({name})")
        return
    print(f"Read EPC: {epc}")
    sku  = input("SKU / item code: ").strip()
    if not sku:
        print("Cancelled (no SKU entered).")
        return
    name = input("Item name (optional): ").strip()
    mapping_ws.append_row([epc, sku, name, datetime.now().isoformat(timespec="seconds")])
    mapping[epc] = (sku, name)
    print(f"Registered {epc} -> {sku}")


def run_count(ser, inventory_ws, log_ws, mapping):
    print("\n-- Inventory count --")
    input(f"Press Enter to start a {SWEEP_SECONDS}s sweep (move the reader over the items)...")

    seen = set()
    end = time.time() + SWEEP_SECONDS
    while time.time() < end:
        seen |= inventory_cycle(ser)
    print(f"Distinct tags read: {len(seen)}")

    ts = datetime.now().isoformat(timespec="seconds")
    counts, unknown, log_rows = {}, [], []
    for epc in sorted(seen):
        if epc in mapping:
            sku, name = mapping[epc]
            entry = counts.setdefault(sku, [0, name])
            entry[0] += 1
            log_rows.append([ts, epc, sku])
        else:
            unknown.append(epc)
            log_rows.append([ts, epc, "UNKNOWN"])

    if log_rows:
        log_ws.append_rows(log_rows)
    if counts:
        update_inventory(inventory_ws, counts, ts)

    print("\nCounted by SKU:")
    for sku, (qty, name) in sorted(counts.items()):
        print(f"  {sku:<14}{qty:>4}  {name}")
    if unknown:
        print(f"\n{len(unknown)} unregistered tag(s) seen -- use Enroll to add them:")
        for epc in unknown:
            print(f"  {epc}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print("Connecting to Google Sheets...")
    mapping_ws, inventory_ws, log_ws = open_sheets()
    mapping = load_mapping(mapping_ws)
    print(f"Loaded {len(mapping)} registered tag(s).")

    print(f"Opening reader on {SERIAL_PORT}...")
    ser = open_reader()
    print("Reader connected.\n")

    try:
        while True:
            print("\n[1] Enroll a tag   [2] Run inventory count   [3] Quit")
            choice = input("> ").strip()
            if choice == "1":
                enroll(ser, mapping_ws, mapping)
            elif choice == "2":
                run_count(ser, inventory_ws, log_ws, mapping)
            elif choice == "3":
                break
            else:
                print("Pick 1, 2, or 3.")
    finally:
        ser.close()
        print("Disconnected.")


if __name__ == "__main__":
    main()
