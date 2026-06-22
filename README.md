# RFID Inventory Web App

A local web app for the Vulcan RFID Indium (TSL ASCII 2.0) handheld reader. Pick
a mode in the browser, drive scans with the reader's physical trigger, and have
everything written to a Google Sheet.

## Modes

- **Check In** — pick an item type (TSC / CDU / W.I.F.), fill in its fields
  (manufactured date, serial #, building #), arm the scan, then pull the trigger.
  The read tag is associated with those values and registered in the sheet.
- **Check Out** — just pull the trigger on a tag. The app looks up its type and
  records the check-out (and decrements the inventory count).
- **Inventory** — hold the trigger and sweep; release to count. Unique EPCs are
  resolved to types and the per-type quantities are written to the sheet.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

- Put your Google service-account key next to the app as `credentials.json` and
  share the spreadsheet (`RFID-TRACKING`) with the service account's
  `client_email` as Editor. Enable the Google Sheets and Drive APIs.
- Plug in the reader over USB and confirm the port in `config.py`
  (`SERIAL_PORT`). Adjust item types / fields in `config.py` as needed.

## Run

```bash
python app.py
```

Then open http://127.0.0.1:8000

## Worksheets (auto-created)

- `Items`: EPC | Type | Manufactured Date | Serial # | Building # | Status | Registered At | Last Updated
- `Log`: Timestamp | Action | EPC | Type | Serial # | Building #
- `Inventory`: Type | Quantity | Last Updated

## Notes

- The reader's trigger drives scans: a single press runs `.iv`, and the app
  detects the end of a burst once the reader goes quiet (trigger released).
- Reader and Sheets connections are non-fatal at startup — the UI shows status
  pills and the app keeps trying to reconnect to the reader.
- "Test without hardware" (bottom of the page) injects fake EPCs so you can
  exercise the UI without the physical reader.
- The original CLI (`rfid_inventory.py`) is kept as a reference/fallback.
