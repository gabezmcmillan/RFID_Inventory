"""
Bill-of-lading document scanner (Epson ES-50) driven through the NAPS2 CLI.

NAPS2 (https://www.naps2.com) talks to the scanner via Apple's ImageCaptureCore
framework on macOS, so one subprocess call gives us "feed a sheet, get a PDF"
with no native scanner code here. Install it with:

    brew install --cask naps2

Public API (all blocking; call from an executor thread):
  scan_to_pdf(path)                  scan one sheet -> new PDF at `path`
  scan_to_pdf(path, append_from=p)   scan one sheet -> PDF at `path` with the
                                     pages of `p` in front (multi-page BOLs)
  list_devices()                     device names NAPS2 can see (diagnostics)
  naps2_installed()                  True if the NAPS2 binary exists
  count_pdf_pages(path)              best-effort page count of a PDF

Only one scan may run at a time (module lock): the ES-50 is a single-sheet
feeder and concurrent NAPS2 jobs would fight over it.
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


def _console(args, timeout=None):
    """Run `NAPS2 console <args>` and return the CompletedProcess."""
    cmd = [config.NAPS2_BINARY, "console", *args]
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=timeout or config.SCAN_TIMEOUT_SECONDS)
    except FileNotFoundError:
        raise ScanError(
            "NAPS2 is not installed (expected at "
            f"{config.NAPS2_BINARY}). Install it with: brew install --cask naps2")
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
