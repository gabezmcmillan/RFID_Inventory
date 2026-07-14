# RFID Inventory Web App

A local web app for the Vulcan RFID Indium (TSL ASCII 2.0) handheld reader. Pick
a mode in the browser, drive scans with the reader's physical trigger, and have
everything written to a local SQLite database (`inventory.db`).

The app is **offline-first**: everything works with no internet at all. When a
cloud URL is configured (see *Cloud site + sync* below), a background worker
mirrors inventory to a small Azure-hosted site
(`switch-warehouse.brasfieldgorrie.com`) where jobsite users can view stock and
submit material requests that flow back into the app.

## Modes

- **Check In** — a truckload starts by scanning its bill of lading on the
  document scanner (Epson ES-50); the PDF is stored in `scans/` and becomes the
  truckload's record. The scan is OCRed (NAPS2's built-in Tesseract) and the
  **BOL #, PO # and Vendor are read off the document automatically** — they
  prefill the shipment form as editable guesses (vendor only matches names
  already in the vendor list). Then pick an item type (TSC / CDU / W.I.F.),
  verify/complete the shipment fields (Building #, PO #, Vendor), and for each
  physical unit enter its per-unit fields (SKU, Manufactured Date) and pull the
  trigger to tag it. Every tag is linked to the BOL PDF (viewable from the
  Warehouse). Uploading a PDF or typing the BOL # manually are available as
  fallbacks; uploads are OCRed too when they carry no text layer.
- **Check Out** — pull the trigger on a tag to deliver it to site. The app looks
  up its shipment, stamps the delivered date, and decrements the group quantity
  (marking the group Delivered when it reaches zero).
- **Sweep & Count** — hold the trigger and sweep; release to count. Unique EPCs
  are resolved to types and reported (read-only; does not change quantities).
- **Warehouse** — browse stored inventory. Each item type expands into groups
  (by BOL # or Building #), and each group expands into the individual units.
  Every unit has a **Find** button.
- **Find a Tag** — launched from the Warehouse drill-down. Hold the trigger and
  sweep; a pulse speeds up as you get closer to the chosen tag (uses the reader's
  per-read RSSI).
- **Requests** — material requests submitted on the cloud site, pulled in by
  the sync worker (the mode card shows an open-count badge). **Fulfill** opens
  the Check Out screen in staging mode: scan each box for the request (nothing
  is committed yet, and the site shows "staging for exit"), then **Confirm
  delivery** checks the staged boxes out and marks the request fulfilled in
  one step. Coming up short requires a note for the requester; canceling
  staging returns the request to pending. Decline works from the panel as
  before.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

- Plug in the reader over USB and confirm the port in `config.py`
  (`SERIAL_PORT`). Adjust item types / fields in `config.py` as needed.
- For BOL scanning, install [NAPS2](https://www.naps2.com) (macOS: `brew
  install --cask naps2`; Windows: the installer from naps2.com) and plug in the
  Epson ES-50 over USB. Check `/api/scanner/status` (or just try a scan) to
  confirm the app can see it; scanner settings live in `config.py`
  (`NAPS2_BINARY`, `SCANNER_DEVICE`, ...).
- OCR field extraction needs NAPS2's English OCR component (a one-time
  download). The app installs it automatically on startup when it can reach the
  internet; to do it manually run `"/Applications/NAPS2.app/Contents/MacOS/NAPS2"
  console --install ocr-eng` (macOS) or `NAPS2.Console.exe --install ocr-eng`
  (Windows). Without it, scanning still works — the BOL/PO/Vendor fields just
  aren't prefilled. OCR settings: `OCR_ENABLED` / `OCR_LANG` in `config.py`.
  `python bol_extract.py scans/<file>.pdf` shows what OCR read from a stored
  PDF and which fields were parsed out (useful for tuning the heuristics).
- The database is created automatically at `config.DB_PATH` (`inventory.db`) on
  first run. It is gitignored, so each machine starts fresh.

## Run

```bash
python app.py
```

Then open http://127.0.0.1:8000

## Building the Windows app (.exe)

The repo ships a PyInstaller setup that packages the whole app (server +
browser UI) into a self-contained folder — no Python needed on the machine
that runs it. PyInstaller cannot cross-compile, so the build itself must
happen **on a Windows machine**:

1. Install [Python 3.10+](https://www.python.org/downloads/windows/) with
   **"Add python.exe to PATH"** checked.
2. Copy this repo onto the machine and double-click `build-windows.bat`
   (it installs the requirements + PyInstaller and runs the spec).
3. The result is `dist\RFIDInventory\` — copy that whole folder anywhere
   (e.g. `C:\RFIDInventory`) and make a desktop shortcut to
   `RFIDInventory.exe`.

Double-clicking the exe starts the server in a console window (closing the
window stops the app) and opens the browser UI automatically.

Notes for the machine that runs the exe:

- `settings.ini` next to the exe holds the per-machine values (serial port,
  admin PIN, web port, and the cloud sync settings `cloud_url` /
  `sync_token`). The default `serial_port = auto` finds the reader on its
  own; pin it to e.g. `COM3` if needed (Device Manager > Ports).
- `inventory.db` and `scans\` are created next to the exe on first run — back
  up / migrate by copying them.
- Still separate installs (not bundled): [NAPS2](https://www.naps2.com) and
  the Epson ES-50 driver for BOL scanning. The RFID reader's USB-serial (FTDI)
  driver installs itself via Windows Update on first plug-in.
- The exe is unsigned, so the first launch may show a SmartScreen warning:
  "More info" > "Run anyway".

## Cloud site + sync (optional)

The `cloud/` directory holds a second, lightweight FastAPI app meant for Azure
App Service + Azure Database for PostgreSQL. It serves a **read-only inventory
view** and a **material request form** for jobsite users; the warehouse app
never needs to be reachable from the internet.

- The exe's sync worker (`sync.py`) calls `POST {cloud_url}/sync/exchange`
  every ~30 s (and on demand via the Sync pill / "Sync now"): it pushes a
  snapshot of tags/vendors/notes/BOL metadata plus new audit events, and pulls
  new material requests. All watermarks are row ids, so retries are safe and
  losing WiFi mid-exchange never corrupts anything.
- Offline is the normal case: the topbar Sync pill shows
  "Sync offline · N pending" and everything keeps working; the backlog uploads
  when connectivity returns. Without `cloud_url` configured the pill just
  shows "Sync off".
- To enable it, set in `settings.ini`:

  ```ini
  cloud_url = https://switch-warehouse.brasfieldgorrie.com
  sync_token = <shared secret, same as the cloud app's SYNC_TOKEN>
  ```

- Running the cloud app locally (Docker Postgres), the end-to-end test
  (`cloud/test_sync.py`), and the full Azure deployment walkthrough (App
  Service, Postgres, custom domain, Entra ID sign-in with `/sync/exchange`
  excluded) live in [cloud/README.md](cloud/README.md).

## Database tables (auto-created)

- `tags`: one row per physical EPC — item_type, BOL #, PO #, Building #,
  Vendor, SKU, mfc date, status, received/delivered timestamps, and a
  `bol_doc_id` link to the scanned BOL document. This is the source of truth;
  warehouse quantities are derived as a `COUNT` of in-warehouse tags.
- `bol_docs`: one row per scanned/uploaded bill of lading (the PDF itself lives
  in `scans/`), including the OCR text and the extracted vendor/PO guesses.
- `events`: append-only audit log of IN / OUT / COUNT / BOL_SCAN actions.
- `requests`: material requests pulled from the cloud site plus the manager's
  handling status (fulfilled / declined, note).
- `sync_state`: key/value watermarks used by the sync worker.

## Configuration notes

- Check-in fields are defined in `config.py` with a `scope`: `"shipment"` fields
  are entered once per shipment; `"item"` fields are entered per unit.
- Reader output power is configurable: low for check-in/check-out (with a live
  slider in the UI) and full power for sweeps and the finder.

## Notes

- The reader's trigger drives scans: a single press runs `.iv`, and the app
  detects the end of a burst once the reader goes quiet (trigger released).
- Reader, database and cloud-sync status are shown as pills; the reader and
  the sync worker both reconnect on their own (clicking the Sync pill forces
  a sync).
- "Test without hardware" (bottom of the page) injects fake EPCs so you can
  exercise the UI without the physical reader.
- The finder relies on the reader streaming RSSI (`RI:` lines via `.iv -r on`);
  confirm the switch and value range on your hardware and tune the mapping in
  `static/app.js` (`onFinder`) if needed.
- The original CLI (`rfid_inventory.py`) is kept as a reference.
- The previous Google Sheets backend is preserved on the `main` branch.
