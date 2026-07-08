"""
Bill-of-lading document scanner (Epson ES-50) driven through the NAPS2 CLI.

NAPS2 (https://www.naps2.com) gives us "feed a sheet, get a PDF" with no
native scanner code here. Install: `brew install --cask naps2` on macOS, or
the regular installer from naps2.com on Windows (the CLI lives in
NAPS2.Console.exe next to the GUI exe).

Public API (all blocking; call from an executor thread):
  scan_to_pdf(path)                  scan one sheet -> new PDF at `path`
  scan_to_pdf(path, append_from=p)   scan one sheet -> PDF at `path` with the
                                     pages of `p` in front (multi-page BOLs)
  ocr_pdf(path)                      re-write `path` with an OCR text layer
  extract_pdf_text(path)             text of a PDF's text layer ("" if none)
  ensure_ocr_component()             best-effort `--install ocr-<lang>`
  list_devices()                     device names NAPS2 can see (diagnostics)
  naps2_installed()                  True if the NAPS2 binary exists
  count_pdf_pages(path)              best-effort page count of a PDF

Only one scan may run at a time (module lock): the ES-50 is a single-sheet
feeder and concurrent NAPS2 jobs would fight over it.

OCR: scans pass `--ocrlang` so NAPS2's bundled Tesseract embeds a searchable
text layer in the output PDF; `ocr_pdf` does the same for uploaded PDFs that
have no text layer. Needs the one-time language component (see
`ensure_ocr_component`). All OCR is best-effort: without it the app still
scans/uploads fine, fields just aren't auto-extracted.
"""

import os
import re
import shutil
import subprocess
import tempfile
import threading

import config


class ScannerBusy(Exception):
    """A scan is already in progress."""


class ScanError(Exception):
    """Scan failed; the message is safe to show to the operator."""


_scan_lock = threading.Lock()


def naps2_installed():
    return os.path.isfile(config.NAPS2_BINARY)


def _component_dirs():
    """Where NAPS2 keeps downloaded components (OCR language packs)."""
    if config.IS_WINDOWS:
        dirs = []
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            dirs.append(os.path.join(appdata, "NAPS2", "components"))
        # Portable install keeps its data next to the executable.
        dirs.append(os.path.join(
            os.path.dirname(config.NAPS2_BINARY), "..", "Data", "components"))
        return dirs
    return [os.path.expanduser("~/.config/naps2/components")]


def ocr_component_installed():
    """True if a Tesseract OCR component has been downloaded.

    Gates the `--ocrlang` flag: passing it without the component could fail
    the whole scan, and a scan must never break because OCR isn't set up.
    """
    for d in _component_dirs():
        try:
            names = os.listdir(d)
        except OSError:
            continue
        if any("tesseract" in n.lower() or "ocr" in n.lower() for n in names):
            return True
    return False


def _ocr_ready():
    return config.OCR_ENABLED and ocr_component_installed()


def _console(args, timeout=None):
    """Run the NAPS2 CLI with <args> and return the CompletedProcess.

    macOS ships one binary (`NAPS2 console <args>`); on Windows the console
    is its own executable (`NAPS2.Console.exe <args>`).
    """
    if config.IS_WINDOWS:
        cmd = [config.NAPS2_BINARY, *args]
        install_hint = "Install it from https://www.naps2.com"
    else:
        cmd = [config.NAPS2_BINARY, "console", *args]
        install_hint = "Install it with: brew install --cask naps2"
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=timeout or config.SCAN_TIMEOUT_SECONDS)
    except FileNotFoundError:
        raise ScanError(
            "NAPS2 is not installed (expected at "
            f"{config.NAPS2_BINARY}). {install_hint}")
    except subprocess.TimeoutExpired:
        raise ScanError("The scan timed out. Check the scanner and try again.")


def _friendly_error(proc):
    """Turn NAPS2 console output into an operator-friendly message."""
    out = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
    low = out.lower()
    if "no scanned pages" in low or "no pages" in low:
        return ("No page detected. Insert the document into the scanner "
                "feeder and try again.")
    if "permission" in low:
        return ("macOS blocked the scan app from saving the file. In System "
                "Settings > Privacy & Security > Files and Folders, allow "
                "NAPS2 access, then try again.")
    if ("not found" in low or "no device" in low or "could not find" in low
            or "not available" in low):
        return ("Scanner not found. Check that the Epson ES-50 is plugged in "
                "over USB and powered on.")
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    if lines:
        return f"Scan failed: {lines[-1]}"
    return "Scan failed for an unknown reason. Check the scanner and try again."


def scan_to_pdf(output_path, append_from=None):
    """Scan a sheet from the feeder into `output_path` (PDF).

    With `append_from`, that PDF's pages are imported first so the new scan is
    appended after them (NAPS2 prepends `-i` files to the output). `append_from`
    may be the same path as `output_path`.

    NAPS2 is a GUI app bundle, so macOS privacy protection (TCC) can deny it
    access to files under ~/Documents ("You don't have permission to save files
    at this location"). All of NAPS2's reads/writes therefore happen in the
    system temp dir, and this (Python) process moves the result into place.
    """
    if not _scan_lock.acquire(blocking=False):
        raise ScannerBusy("A scan is already in progress. Wait for it to finish.")
    workdir = None
    try:
        parent = os.path.dirname(output_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        workdir = tempfile.mkdtemp(prefix="bolscan_")
        tmp_out = os.path.join(workdir, "scan.pdf")
        args = ["-o", tmp_out, "--noprofile",
                "--driver", config.SCANNER_DRIVER,
                "--device", config.SCANNER_DEVICE,
                "--source", "feeder",
                "--dpi", str(config.SCAN_DPI),
                "--pagesize", "letter",
                "-f", "-v"]
        if _ocr_ready():
            args += ["--ocrlang", config.OCR_LANG]
        if append_from and os.path.exists(append_from):
            tmp_in = os.path.join(workdir, "existing.pdf")
            shutil.copy2(append_from, tmp_in)
            args += ["-i", tmp_in]
        proc = _console(args)
        if not os.path.exists(tmp_out) or os.path.getsize(tmp_out) == 0:
            raise ScanError(_friendly_error(proc))
        shutil.move(tmp_out, output_path)
        return output_path
    finally:
        if workdir:
            shutil.rmtree(workdir, ignore_errors=True)
        _scan_lock.release()


def ocr_pdf(path):
    """Re-write `path` with an OCR text layer (for uploads with no text).

    Runs the NAPS2 import pass (no scanning: `-n 0`) so the bundled Tesseract
    OCRs the existing pages. Best-effort: on any failure the original file is
    left untouched and False is returned.
    """
    if not (_ocr_ready() and naps2_installed() and os.path.exists(path)):
        return False
    if not _scan_lock.acquire(blocking=False):
        return False  # scanner busy; skip OCR rather than queue behind it
    workdir = None
    try:
        workdir = tempfile.mkdtemp(prefix="bolocr_")
        tmp_in = os.path.join(workdir, "in.pdf")
        tmp_out = os.path.join(workdir, "out.pdf")
        shutil.copy2(path, tmp_in)
        proc = _console(["-i", tmp_in, "-o", tmp_out, "-n", "0",
                         "--noprofile", "--ocrlang", config.OCR_LANG])
        if proc.returncode != 0 or not os.path.exists(tmp_out) \
                or os.path.getsize(tmp_out) == 0:
            return False
        shutil.move(tmp_out, path)
        return True
    except (ScanError, OSError):
        return False
    finally:
        if workdir:
            shutil.rmtree(workdir, ignore_errors=True)
        _scan_lock.release()


def extract_pdf_text(path):
    """Text from the PDF's embedded text layer ("" if none or unreadable)."""
    try:
        from pypdf import PdfReader
    except ImportError:
        return ""
    try:
        reader = PdfReader(path)
        parts = []
        for page in reader.pages:
            try:
                parts.append(page.extract_text() or "")
            except Exception:  # noqa: BLE001 - one bad page shouldn't kill the rest
                continue
        return "\n".join(parts).strip()
    except Exception:  # noqa: BLE001 - malformed/encrypted PDF: no text, no crash
        return ""


def ensure_ocr_component():
    """Best-effort one-time download of NAPS2's OCR language component.

    Idempotent (NAPS2 no-ops if already installed). Called from app startup in
    a background thread; needs network the first time. Failure is fine — OCR
    just won't produce text until `--install ocr-eng` is run manually.
    """
    if not (config.OCR_ENABLED and naps2_installed()):
        return False
    try:
        proc = _console(["--install", f"ocr-{config.OCR_LANG}"], timeout=180)
        return proc.returncode == 0
    except (ScanError, OSError):
        return False


def list_devices():
    """Names of the scanners NAPS2 can see (for setup / health checks)."""
    proc = _console(["--listdevices", "--driver", config.SCANNER_DRIVER],
                    timeout=45)
    lines = [l.strip() for l in (proc.stdout or "").splitlines() if l.strip()]
    if proc.returncode != 0 and not lines:
        raise ScanError(_friendly_error(proc))
    return lines


def count_pdf_pages(path):
    """Best-effort page count (used for display only, so 1 is a safe floor)."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return 1
    # Page-tree /Count entries first (max covers nested trees), then a raw
    # count of page objects for PDFs whose tree is inside an object stream.
    counts = [int(m) for m in re.findall(rb"/Count\s+(\d+)", data)]
    if counts:
        return max(counts)
    n = len(re.findall(rb"/Type\s*/Page\b(?!s)", data))
    return n or 1
