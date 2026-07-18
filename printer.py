"""
Label printing + RFID encoding on the Zebra ZD621R (300 dpi, 4x6" RFID media).

The printer speaks raw ZPL over TCP port 9100 -- no driver, no OS print queue.
Each check-in label is one ZPL format: the visible fields plus a ^RFW,H write
that burns the app-minted EPC into the label's UHF inlay during the same pass.
The printer verifies every write; a failed encode prints VOID across the label
and automatically retries the same data on the next one, so a successfully
sent job eventually yields exactly one good label per format.

Two settings deliberately do NOT appear in the ZPL:
  - Label length (^LL): the printer's media calibration governs it. Declaring
    a longer length overruns the inter-label gap and feeds a blank label.
  - RFID program position / write power (^RS): established by the printer's
    RFID tag calibration (LCD > RFID > RFID Calibrate) and stored in the
    printer. If labels start voiding with "NO TAG FOUND" -- or a blank label
    trails each print -- re-run that calibration (FEED once to resync first,
    leave slack media out the front for the backfeed).

Public API (all blocking; call from an executor thread):
  enabled()        True when a printer_host is configured (settings.ini)
  print_label(...) build + send one label (raises PrintError)
  status()         reachability / error state via a ~HS host-status query
"""

import re
import socket
import textwrap

import config


class PrintError(Exception):
    """Label could not be sent; the message is safe to show the operator."""


# A standard 96-bit EPC is exactly 24 hex characters.
EPC_HEX = re.compile(r"^[0-9A-F]{24}$")

# 300 dpi geometry: 4" printable width = 1218 dots. Positions were iterated
# against the Labelary renderer and verified on the physical printer.
LABEL_ZPL = """^XA
^PW1218
^FO0,70^A0N,300,300^FB1218,1,0,C^FDATL {building}^FS
^FO0,380^A0N,150,150^FB1218,1,0,C^FDSector: {sector}^FS
^FO70,570^GB1078,4,4^FS
^FO70,640^A0N,46,46^FDDESCRIPTION^FS
^FO440,630^A0N,{desc_font},{desc_font}^FB740,{desc_lines},0,L^FD{description}^FS
^FO70,830^A0N,46,46^FDSUPPLIER^FS
^FO440,820^A0N,66,66^FB740,1,0,L^FD{supplier}^FS
^FO70,1020^A0N,46,46^FDPART / SKU^FS
^FO440,1010^A0N,66,66^FB740,1,0,L^FD{sku}^FS
^FO70,1210^A0N,46,46^FDQTY^FS
^FO440,1200^A0N,66,66^FD{quantity}^FS
^FO70,1400^A0N,46,46^FDPO #^FS
^FO440,1390^A0N,66,66^FD{po_number}^FS
^FO70,1590^A0N,46,46^FDRECEIVED^FS
^FO440,1580^A0N,66,66^FDDate: {received_date}^FS
^FO440,1670^A0N,66,66^FDTime: {received_time}^FS
{qr}^RFW,H^FD{epc}^FS
^XZ
"""

# QR code linking to the box's cloud page (bottom-right, clear of the short
# QTY/PO values in the left column). Magnification 6 keeps an ~80-char URL
# inside the label's right margin at 300 dpi while staying easily phone-
# scannable. Only included when a cloud URL is configured.
QR_ZPL = "^FO950,1150^BQN,2,6^FDQA,{url}^FS\n"

# Description block: 740 dots wide, and the ~200 dots above the SUPPLIER
# label fit at most 2 lines at the standard 66-dot font. ZPL's ^FB handles
# overflow by re-printing the remainder OVER the block's last line, which is
# exactly the mess long W.I.F. component names caused -- so the font steps
# down (more, smaller lines in the same vertical space) until the text fits.
DESC_WIDTH = 740
DESC_TIERS = (        # (font height in dots, max lines)
    (66, 2),
    (50, 3),
    (40, 4),
)
# Conservative average glyph advance relative to font height for the ^A0
# font (CG Triumvirate Bold Condensed). Overestimating width just makes the
# font step down a little early; underestimating would overprint.
DESC_CHAR_W = 0.55


def _desc_layout(text):
    """Pick (font, max_lines, text) so `text` fits the description block.

    Largest tier that holds the whole text wins, estimating ^FB's greedy
    word-wrap with textwrap at a conservative characters-per-line. If even
    the smallest tier can't, the text is cut at its last full line with a
    trailing ellipsis rather than letting ^FB overprint the last line.
    """
    for font, max_lines in DESC_TIERS:
        per_line = int(DESC_WIDTH / (font * DESC_CHAR_W))
        if len(textwrap.wrap(text, per_line)) <= max_lines:
            return font, max_lines, text
    font, max_lines = DESC_TIERS[-1]
    per_line = int(DESC_WIDTH / (font * DESC_CHAR_W))
    while text:
        candidate = text.rstrip(" .") + "..."
        if len(textwrap.wrap(candidate, per_line)) <= max_lines:
            return font, max_lines, candidate
        text = text[:-1]
    return font, max_lines, "..."


def enabled():
    return bool(config.PRINTER_HOST)


def _zpl_safe(value):
    """Neutralize ZPL control characters (^ ~) and control codes in field data."""
    return re.sub(r"[\^~\x00-\x1f\x7f]", " ", str(value or "")).strip()


def _send(data, timeout=5):
    if not enabled():
        raise PrintError(
            "No label printer configured (set printer_host in settings.ini)")
    try:
        with socket.create_connection(
                (config.PRINTER_HOST, config.PRINTER_PORT),
                timeout=timeout) as sock:
            sock.sendall(data.encode("ascii", "replace"))
    except OSError as exc:
        raise PrintError(
            f"Printer unreachable at {config.PRINTER_HOST}:"
            f"{config.PRINTER_PORT} ({exc})") from exc


def print_label(epc, building="", sector="", description="", supplier="",
                sku="", quantity="", po_number="", received_date="",
                received_time="", qr_url=""):
    """Print one 4x6 label and encode `epc` into its RFID inlay.

    `qr_url` (optional) adds a QR code so a phone scan opens the box's cloud
    page (which links the BOL PDF). Raises PrintError if the EPC is malformed
    or the printer can't be reached. A successful return means the job was
    accepted; encode failures on bad inlays are handled by the printer itself
    (VOID + retry).
    """
    epc = str(epc or "").upper()
    if not EPC_HEX.match(epc):
        raise PrintError(f"Bad EPC for encoding (need 24 hex chars): {epc!r}")
    qr = QR_ZPL.format(url=_zpl_safe(qr_url)) if qr_url else ""
    desc_font, desc_lines, desc_text = _desc_layout(_zpl_safe(description))
    zpl = LABEL_ZPL.format(
        epc=epc,
        qr=qr,
        building=_zpl_safe(building),
        sector=_zpl_safe(sector),
        description=desc_text,
        desc_font=desc_font,
        desc_lines=desc_lines,
        supplier=_zpl_safe(supplier),
        sku=_zpl_safe(sku),
        quantity=_zpl_safe(quantity),
        po_number=_zpl_safe(po_number),
        received_date=_zpl_safe(received_date),
        received_time=_zpl_safe(received_time),
    )
    _send(zpl)


def status(timeout=3):
    """Printer health check via ~HS (prints nothing, consumes no media).

    Returns {"ok": bool, "message": str} for the UI / diagnostics.
    """
    if not enabled():
        return {"ok": False,
                "message": ("No label printer configured "
                            "(set printer_host in settings.ini).")}
    try:
        with socket.create_connection(
                (config.PRINTER_HOST, config.PRINTER_PORT),
                timeout=timeout) as sock:
            sock.sendall(b"~HS")
            sock.settimeout(timeout)
            data = b""
            # ~HS answers with three STX...ETX strings.
            while data.count(b"\x03") < 3:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
    except OSError as exc:
        return {"ok": False,
                "message": (f"Printer unreachable at {config.PRINTER_HOST}:"
                            f"{config.PRINTER_PORT} ({exc})")}

    try:
        strings = [s.strip(b"\r\n\x02").decode("ascii")
                   for s in data.split(b"\x03")]
        s1, s2 = strings[0].split(","), strings[1].split(",")
        problems = []
        if s1[1] == "1":
            problems.append("media out")
        if s1[2] == "1":
            problems.append("paused")
        if s2[1] == "1":
            problems.append("printhead open")
        if problems:
            return {"ok": False, "message": "Printer: " + ", ".join(problems)}
        return {"ok": True, "message": "Printer ready."}
    except (IndexError, ValueError, UnicodeDecodeError):
        # It answered on the ZPL port; treat unparseable status as alive.
        return {"ok": True, "message": "Printer answered."}
