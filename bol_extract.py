"""
Pull BOL #, PO # and Vendor out of a bill of lading's OCR text.

Pure heuristics over the text layer that NAPS2/Tesseract embeds in scanned
PDFs (see scanner.py). Carrier layouts vary wildly, so this aims for a good
first guess, never a guarantee: the check-in UI shows what was found and the
operator can correct anything before arming the shipment.

    extract_fields(text, vendors) -> {"bol_number": "", "po_number": "", "vendor": ""}

Values are matched two ways:
  - same line as a label   ("BOL NO: 123456789")
  - line right below it    ("BOL NO." / next row "123456789"), the usual
                           table-header layout on preprinted forms
Vendor is only ever one of the names already in the vendors table (exact or
fuzzy word-window match) so OCR noise can never invent a new vendor.

Tuning aid:  python bol_extract.py scans/some_bol.pdf
prints the extracted text followed by the parsed fields (vendor list is read
from the SQLite DB when present).
"""

import difflib
import re

# An "ID-looking" token: starts alphanumeric, then letters/digits/-/. up to 24
# chars, and must contain at least one digit somewhere (rejects DATE, PREPAID,
# column headers, ...).
_ID_TOKEN = re.compile(r"(?=[A-Za-z0-9\-/.]{0,23}\d)[A-Za-z0-9][A-Za-z0-9\-/.]{2,23}")
_DATE_SHAPE = re.compile(r"\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$")

_NUM_WORD = r"(?:NUMBER|NBR|NUM|NO\.?|#)"
# Label word must not run into another word (LADING vs LADINGS is fine either
# way, but BL must not match inside BLOCK, PO not inside PORT).
_BOL_LABEL = (r"(?<![A-Za-z0-9])(?:BILL\s*OF\s*LADING|B\s*/\s*L|B\.L\.?|BOL|BL)"
              r"(?![A-Za-z])")
_PO_LABEL = (r"(?<![A-Za-z0-9])(?:PURCHASE\s*ORDER|CUST(?:OMER)?\.?\s*ORDER"
             r"|CUST(?:OMER)?\.?\s*P\.?\s*O\.?|P\.?\s*O\.?|P/O)(?![A-Za-z])")

# label + optional NUMBER/NO/# + separator, used for both match styles.
def _label_head(label_re):
    return rf"{label_re}\s*(?:{_NUM_WORD})?\s*[:#=]*\s*"


def _clean_value(raw):
    """Trim trailing punctuation and reject non-ID shapes ("" if rejected)."""
    value = (raw or "").strip().strip(".,;:-/")
    # OCR often drops the space after a number, gluing the next word onto it
    # ("79299Shipper", "429660PO"). A 2+ letter run straight after a digit is
    # such an artifact, not part of the ID.
    value = re.sub(r"(?<=\d)[A-Za-z]{2,}$", "", value)
    if len(value) < 3 or not any(ch.isdigit() for ch in value):
        return ""
    if _DATE_SHAPE.fullmatch(value):
        return ""  # "07/07/2026" next to "BOL DATE" is a date, not a number
    return value


def _find_labeled_value(lines, label_re, not_followed_by=""):
    """Best ID value for a label across all lines.

    Returns (value, line_index) or ("", -1). Same-line matches outrank
    below-line matches; an explicit NUMBER/NO/# word outranks a bare label;
    earlier lines win ties (these numbers live at the top of the form).
    """
    head = _label_head(label_re)
    guard = rf"(?!{not_followed_by})" if not_followed_by else ""
    same_line = re.compile(rf"{head}{guard}({_ID_TOKEN.pattern})", re.IGNORECASE)
    # Bare header cell: the whole line is just the label (value lives below).
    header_only = re.compile(rf"{head}$", re.IGNORECASE)
    has_num_word = re.compile(rf"{label_re}\s*{_NUM_WORD}", re.IGNORECASE)

    best = ("", -1, 0.0)
    for idx, line in enumerate(lines):
        line = line.strip()
        if not line:
            continue
        score, value = 0.0, ""
        m = same_line.search(line)
        if m:
            value = _clean_value(m.group(1))
            if value:
                score = 2.0
        if not value and header_only.fullmatch(line):
            # Value is the first ID-looking token on the next non-empty line.
            for nxt in lines[idx + 1:idx + 3]:
                nxt = nxt.strip()
                if not nxt:
                    continue
                first = nxt.split()[0]
                value = _clean_value(first) if _ID_TOKEN.fullmatch(first) else ""
                score = 1.0
                break
        if not value:
            continue
        if has_num_word.search(line):
            score += 0.5
        if score > best[2]:
            best = (value, idx, score)
    return best[0], best[1]


# -- vendor -------------------------------------------------------------------
_VENDOR_HINTS = ("vendor", "shipper", "supplier", "ship from", "from", "sold by")
_COMPANY_SUFFIXES = {"inc", "incorporated", "llc", "ltd", "limited", "corp",
                     "corporation", "co", "company"}
_FUZZY_THRESHOLD = 0.8


def _norm(s):
    return " ".join(re.sub(r"[^a-z0-9]+", " ", s.lower()).split())


def _vendor_variants(name):
    """Normalized forms to try: full name, and the name minus trailing
    company suffixes ("Acme Corp" is usually printed as just "ACME")."""
    full = _norm(name)
    variants = [full] if full else []
    words = full.split()
    while len(words) > 1 and words[-1] in _COMPANY_SUFFIXES:
        words = words[:-1]
    stripped = " ".join(words)
    if stripped and stripped != full and len(stripped) >= 4:
        variants.append(stripped)
    return variants


def match_vendor(text, vendors):
    """Best matching known vendor in the text ("" if none clears the bar).

    Exact word-boundary hits beat fuzzy ones; being on/right under a
    Vendor/Shipper/From-style label adds a small bonus.
    """
    vendors = [v for v in (vendors or []) if (v or "").strip()]
    if not vendors:
        return ""
    lines = [_norm(l) for l in text.splitlines()]
    best_name, best_score = "", 0.0
    for idx, line in enumerate(lines):
        if not line:
            continue
        near_hint = any(
            hint in lines[j]
            for j in range(max(0, idx - 2), idx + 1)
            for hint in _VENDOR_HINTS)
        words = line.split()
        for name in vendors:
            for variant in _vendor_variants(name):
                score = 0.0
                if f" {variant} " in f" {line} ":
                    score = 1.0
                elif len(variant) >= 4:
                    n = len(variant.split())
                    for i in range(max(1, len(words) - n + 1)):
                        window = " ".join(words[i:i + n])
                        ratio = difflib.SequenceMatcher(
                            None, variant, window).ratio()
                        if ratio > score:
                            score = ratio
                    if score < _FUZZY_THRESHOLD:
                        score = 0.0
                if not score:
                    continue
                if near_hint:
                    score += 0.1
                # Longer names are more specific; break score ties with them.
                if score > best_score or (
                        score == best_score and len(name) > len(best_name)):
                    best_name, best_score = name, score
    return best_name


# -- public entry point ---------------------------------------------------------
def extract_fields(text, vendors=()):
    """Parse OCR text into {"bol_number", "po_number", "vendor"} guesses.

    Every value is "" when not found; callers fall back to their existing
    defaults (timestamp reference, blank form fields).
    """
    result = {"bol_number": "", "po_number": "", "vendor": ""}
    if not (text or "").strip():
        return result
    lines = text.splitlines()

    bol, _ = _find_labeled_value(lines, _BOL_LABEL)
    # "P.O. Box 12345" is an address; require the PO label not be followed by
    # BOX. A PO value identical to the BOL value is a shared "BOL/PO" line --
    # keep it as the BOL only.
    po, _ = _find_labeled_value(lines, _PO_LABEL, not_followed_by=r"BOX\b")
    if po and po.lower() == (bol or "").lower():
        po = ""
    result["bol_number"] = bol
    result["po_number"] = po
    result["vendor"] = match_vendor(text, vendors)
    return result


# -- tuning CLI -------------------------------------------------------------------
def _vendors_from_db():
    """Vendor names straight from the SQLite file (read-only, best effort)."""
    import os
    import sqlite3

    import config
    if not os.path.exists(config.DB_PATH):
        return []
    try:
        conn = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
        try:
            rows = conn.execute("SELECT name FROM vendors").fetchall()
            return [r[0] for r in rows]
        finally:
            conn.close()
    except sqlite3.Error:
        return []


if __name__ == "__main__":
    import json
    import sys

    import scanner

    if len(sys.argv) != 2:
        print("usage: python bol_extract.py <path-to-bol.pdf>")
        raise SystemExit(2)
    pdf_text = scanner.extract_pdf_text(sys.argv[1])
    print("--- extracted text " + "-" * 40)
    print(pdf_text or "(no text layer found -- has the PDF been OCRed?)")
    print("--- parsed fields  " + "-" * 40)
    print(json.dumps(extract_fields(pdf_text, _vendors_from_db()), indent=2))
