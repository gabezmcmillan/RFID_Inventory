# RFID Inventory Web App

A local web app for the Vulcan RFID Indium (TSL ASCII 2.0) handheld reader. Pick
a mode in the browser, drive scans with the reader's physical trigger, and have
everything written to a local SQLite database (`inventory.db`).

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

## Database tables (auto-created)

- `tags`: one row per physical EPC — item_type, BOL #, PO #, Building #,
  Vendor, SKU, mfc date, status, received/delivered timestamps, and a
  `bol_doc_id` link to the scanned BOL document. This is the source of truth;
  warehouse quantities are derived as a `COUNT` of in-warehouse tags.
- `bol_docs`: one row per scanned/uploaded bill of lading (the PDF itself lives
  in `scans/`), including the OCR text and the extracted vendor/PO guesses.
- `events`: append-only audit log of IN / OUT / COUNT / BOL_SCAN actions.

## Configuration notes

- Check-in fields are defined in `config.py` with a `scope`: `"shipment"` fields
  are entered once per shipment; `"item"` fields are entered per unit.
- Reader output power is configurable: low for check-in/check-out (with a live
  slider in the UI) and full power for sweeps and the finder.

## Notes

- The reader's trigger drives scans: a single press runs `.iv`, and the app
  detects the end of a burst once the reader goes quiet (trigger released).
- Reader and database status are shown as pills; the reader reconnects on its own.
- "Test without hardware" (bottom of the page) injects fake EPCs so you can
  exercise the UI without the physical reader.
- The finder relies on the reader streaming RSSI (`RI:` lines via `.iv -r on`);
  confirm the switch and value range on your hardware and tune the mapping in
  `static/app.js` (`onFinder`) if needed.
- The original CLI (`rfid_inventory.py`) is kept as a reference.
- The previous Google Sheets backend is preserved on the `main` branch.
