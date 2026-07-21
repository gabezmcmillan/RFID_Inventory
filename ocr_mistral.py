"""
BOL field extraction through Mistral's OCR 4 cloud API.

One POST to https://api.mistral.ai/v1/ocr with the BOL PDF (base64) and a
JSON-schema "document annotation": Mistral OCRs the pages layout-aware and a
vision LLM fills {bol_number, po_number, vendor} directly from the document,
which handles the table-header forms the local regex heuristics
(bol_extract.py) can only guess at.

    enabled()                     -> True when an API key is configured
    extract_fields(path, vendors) -> {"bol_number", "po_number", "vendor",
                                      "ocr_text", "line_items"} or None on
                                      any failure

line_items is the document's goods lines as
[{"item_no", "item_name", "quantity"}, ...]; the check-in UI offers them as
one-tap prefills for the per-unit fields.

Used as the primary extraction path in app._extract_bol_fields when
settings.ini has a mistral_api_key; every failure (offline, timeout, bad
response) returns None so the caller falls back to the local pipeline --
this module must never break a scan.

The vendor answer is never trusted verbatim: it is re-matched against the
vendors table via bol_extract.match_vendor, so OCR/model noise can't invent
a vendor (same guarantee as the local path).

Tuning aid:  python ocr_mistral.py scans/some_bol.pdf
prints the returned markdown and the parsed fields (reads the API key from
settings.ini/config.py and vendors from the SQLite DB when present).
"""

import base64
import json
import os

import requests

import bol_extract
import config

_OCR_URL = "https://api.mistral.ai/v1/ocr"

MAX_LINE_ITEMS = 30

# What the annotation LLM is asked to fill in. Field descriptions double as
# extraction instructions.
_ANNOTATION_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "bol_fields",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["bol_number", "po_number", "vendor", "items"],
            "properties": {
                "bol_number": {
                    "type": "string",
                    "description": (
                        "The bill of lading number (labeled BOL, B/L, BL or "
                        "Bill of Lading No). Empty string if not present."),
                },
                "po_number": {
                    "type": "string",
                    "description": (
                        "The purchase order / customer order number (labeled "
                        "PO, P.O. or Purchase Order). A 'P.O. Box' is a "
                        "postal address, NOT a PO number. Empty string if "
                        "not present."),
                },
                "vendor": {
                    "type": "string",
                    "description": (
                        "The vendor: the company that supplied the goods "
                        "(usually the shipper / ship-from party, not the "
                        "carrier and not the consignee). Empty string if "
                        "not present."),
                },
                "items": {
                    "type": "array",
                    "description": (
                        "The goods line items on the document, one entry "
                        "per distinct product line. Skip totals, freight "
                        "charges, and pallet/packaging rows. Empty array "
                        "if no line items are listed."),
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["item_no", "item_name", "quantity"],
                        "properties": {
                            "item_no": {
                                "type": "string",
                                "description": (
                                    "The line's part / item / product "
                                    "number, e.g. 4000-222-01. Empty "
                                    "string if the line has none."),
                            },
                            "item_name": {
                                "type": "string",
                                "description": (
                                    "The line's product description / "
                                    "name, e.g. CATCH BASIN SUPPORT."),
                            },
                            "quantity": {
                                "type": "string",
                                "description": (
                                    "The quantity shipped on this line "
                                    "(the shipped/ship qty column, not "
                                    "ordered or back-ordered), e.g. 700. "
                                    "Empty string if not shown."),
                            },
                        },
                    },
                },
            },
        },
    },
}

_ANNOTATION_PROMPT = (
    "This document is a freight bill of lading for a construction-materials "
    "warehouse. Extract the bill of lading number, the purchase order "
    "number, the vendor (supplier/shipper company), and the goods line "
    "items (each line's item/part number, product description and shipped "
    "quantity; ignore totals, freight charges and packaging rows). Copy "
    "values exactly as printed; use an empty string for anything not on "
    "the document.")


def enabled():
    return bool(config.MISTRAL_API_KEY)


def _annotation_prompt(vendors):
    prompt = _ANNOTATION_PROMPT
    names = [v for v in (vendors or []) if (v or "").strip()]
    if names:
        prompt += (" Known vendors (prefer the matching one for the vendor "
                   "field): " + "; ".join(names) + ".")
    return prompt


def extract_fields(pdf_path, vendors=()):
    """Mistral-extracted BOL fields for the PDF, or None on any failure.

    Blocking (one HTTPS round trip); call from an executor thread. The
    result has the same shape app._extract_bol_fields returns:
    {"bol_number", "po_number", "vendor", "ocr_text", "line_items"} with ""
    for unknowns and [] for no line items.
    """
    if not enabled():
        return None
    try:
        with open(pdf_path, "rb") as f:
            pdf_b64 = base64.b64encode(f.read()).decode("ascii")
    except OSError:
        return None

    payload = {
        "model": config.MISTRAL_OCR_MODEL,
        "document": {
            "type": "document_url",
            "document_url": f"data:application/pdf;base64,{pdf_b64}",
        },
        "document_annotation_format": _ANNOTATION_SCHEMA,
        "document_annotation_prompt": _annotation_prompt(vendors),
    }
    try:
        resp = requests.post(
            _OCR_URL, json=payload,
            headers={"Authorization": f"Bearer {config.MISTRAL_API_KEY}"},
            timeout=config.MISTRAL_OCR_TIMEOUT_SECONDS)
        resp.raise_for_status()
        body = resp.json()
    except (requests.RequestException, ValueError):
        return None

    pages = body.get("pages") or []
    markdown = "\n\n".join(
        (p.get("markdown") or "") for p in pages).strip()
    try:
        annotation = json.loads(body.get("document_annotation") or "{}")
    except ValueError:
        annotation = {}
    if not markdown and not annotation:
        return None  # nothing usable; let the local pipeline try

    bol = _clean(annotation.get("bol_number"))
    po = _clean(annotation.get("po_number"))
    if po and po.lower() == bol.lower():
        po = ""  # shared "BOL/PO" value: keep it as the BOL only
    # Constrain the vendor to the vendors table (exact/fuzzy), never the
    # model's raw string; its answer is just the strongest hint in the text.
    model_vendor = _clean(annotation.get("vendor"))
    vendor = bol_extract.match_vendor(
        f"vendor: {model_vendor}\n{markdown}", vendors)
    return {"bol_number": bol, "po_number": po, "vendor": vendor,
            "ocr_text": markdown,
            "line_items": _clean_items(annotation.get("items"))}


def _clean_items(raw):
    """Normalized [{"item_no", "item_name", "quantity"}] from the model's
    items array.

    Entries without an item number are dropped (nothing to prefill the
    Item No. field with), duplicates collapse to the first occurrence.
    Quantity becomes a positive-integer string ("" when absent/unparseable):
    packing slips print "700.00" / "1,500" but the app counts whole units.
    """
    if not isinstance(raw, list):
        return []
    items, seen = [], set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        item_no = _clean(entry.get("item_no"))
        item_name = _clean(entry.get("item_name"))
        if not item_no or item_no.lower() in seen:
            continue
        seen.add(item_no.lower())
        items.append({"item_no": item_no, "item_name": item_name,
                      "quantity": _clean_quantity(entry.get("quantity"))})
        if len(items) >= MAX_LINE_ITEMS:
            break
    return items


def _clean_quantity(value):
    try:
        qty = int(round(float(_clean(value).replace(",", ""))))
    except (ValueError, TypeError):
        return ""
    return str(qty) if qty > 0 else ""


def _clean(value):
    value = (value or "").strip()
    # Schema descriptions ask for "" when absent, but models still sometimes
    # answer in prose.
    if value.lower() in {"none", "n/a", "na", "not present", "unknown"}:
        return ""
    return value


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 2:
        print("usage: python ocr_mistral.py <path-to-bol.pdf>")
        raise SystemExit(2)
    if not enabled():
        print("No API key: set mistral_api_key in settings.ini first.")
        raise SystemExit(1)
    if not os.path.exists(sys.argv[1]):
        print(f"No such file: {sys.argv[1]}")
        raise SystemExit(1)
    fields = extract_fields(sys.argv[1], bol_extract._vendors_from_db())
    if fields is None:
        print("Mistral OCR call failed (offline? bad key? see settings.ini).")
        raise SystemExit(1)
    print("--- markdown " + "-" * 46)
    print(fields["ocr_text"] or "(no text returned)")
    print("--- parsed fields " + "-" * 41)
    print(json.dumps({k: fields[k] for k in
                      ("bol_number", "po_number", "vendor", "line_items")},
                     indent=2))
