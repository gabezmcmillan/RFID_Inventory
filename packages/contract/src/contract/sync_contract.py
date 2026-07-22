"""
The sync contract: the single definition of which tables and columns cross
the exe->cloud seam.

Both sides import this module -- the exe's export (db.export_snapshot,
db.events_since) sends exactly these columns, and the cloud (cloud/db.py)
generates its mirror DDL from them and applies exchanges against them. To
sync a new column, add it here (and to the local SQLite schema); the cloud
migrates itself on the next deploy's startup.

Version skew is expected (the exe and the cloud deploy independently) and is
handled leniently: an exchange never fails over a column mismatch. The
contract hash travels in the payload and the ack, so a mismatch surfaces as
a warning in the exe's sync status; meanwhile the cloud stores unknown
incoming columns as TEXT so no data is dropped while the two catch up.

This file lives in packages/contract/ -- the one place for code that both
apps depend on. Each app installs the package from its requirements.txt
(a relative-path pip install), so both sides import it the same way:
`from contract import sync_contract`. It must hold no state beyond plain
data.

HARD RULE: stdlib only. Importing this module must never drag cloud-only
dependencies (psycopg, fastapi) into the exe build.
"""

import hashlib
import json

# Types are the *cloud mirror's* storage types (permissive by design -- the
# exe owns validation; see cloud/db.py). The local SQLite schema is richer
# (constraints, defaults) and remains hand-written in db.py.
MIRROR_TABLES = {
    "tags": (
        ("id", "BIGINT"),
        ("epc", "TEXT"),
        ("item_type", "TEXT"),
        ("item_name", "TEXT"),
        ("bol_number", "TEXT"),
        ("po_number", "TEXT"),
        ("building", "TEXT"),
        ("sector", "TEXT"),
        ("vendor", "TEXT"),
        ("sku", "TEXT"),
        ("mfc_date", "TEXT"),
        ("quantity", "INTEGER"),
        ("remaining", "INTEGER"),
        ("status", "TEXT"),
        ("received_at", "TEXT"),
        ("delivered_at", "TEXT"),
        ("checkout_building", "TEXT"),
        ("flag", "TEXT"),
        ("flagged_at", "TEXT"),
        ("created_at", "TEXT"),
        ("updated_at", "TEXT"),
        ("bol_doc_id", "BIGINT"),
    ),
    "vendors": (
        ("name", "TEXT"),
    ),
    "notes": (
        ("id", "BIGINT"),
        ("ts", "TEXT"),
        ("item_type", "TEXT"),
        ("bol_number", "TEXT"),
        ("building", "TEXT"),
        ("text", "TEXT"),
    ),
    # ocr_text is deliberately absent: it can be hundreds of KB per document
    # and the cloud never reads it. Not being in the contract keeps it out of
    # the snapshot automatically.
    "bol_docs": (
        ("id", "BIGINT"),
        ("bol_number", "TEXT"),
        ("filename", "TEXT"),
        ("source", "TEXT"),
        ("pages", "INTEGER"),
        ("vendor", "TEXT"),
        ("po_number", "TEXT"),
        ("auto_named", "INTEGER"),
        ("created_at", "TEXT"),
    ),
}

# Tables replaced wholesale by each snapshot push (carries edits + deletes).
SNAPSHOT_TABLES = tuple(MIRROR_TABLES)

# Events ride separately: append-only above a watermark, keyed by the exe's
# row id (which is why a dropped event column would be lost permanently --
# the lenient unknown-column handling in cloud/db.py exists mostly for them).
EVENTS_TABLE = "events"
EVENT_COLUMNS = (
    ("id", "BIGINT"),
    ("ts", "TEXT"),
    ("action", "TEXT"),
    ("epc", "TEXT"),
    ("item_type", "TEXT"),
    ("bol_number", "TEXT"),
    ("building", "TEXT"),
    ("vendor", "TEXT"),
    ("detail", "TEXT"),
)


def columns(table):
    """Column names for one table, in contract order."""
    if table == EVENTS_TABLE:
        return tuple(name for name, _ in EVENT_COLUMNS)
    return tuple(name for name, _ in MIRROR_TABLES[table])


def contract_hash():
    """Stable hash of the whole contract, exchanged in payload and ack so
    both sides can tell (and warn) when they were built from different
    versions. Any column or type change produces a new hash."""
    structure = {EVENTS_TABLE: EVENT_COLUMNS, **MIRROR_TABLES}
    blob = json.dumps(structure, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()
