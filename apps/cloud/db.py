"""
Postgres layer for the cloud app (Vercel Postgres / Neon in production).

Same house style as the local db.py: raw SQL, no ORM. The cloud holds

  - a read-only MIRROR of the .exe's tables (tags, vendors, notes, bol_docs,
    events), replaced/extended by each sync exchange. The .exe is the source
    of truth; nothing here ever edits mirror rows.
  - the REQUESTS queue, which the cloud owns: jobsite users create rows, the
    .exe pulls them and pushes back fulfilled/declined statuses.
  - sync_meta key/values (last exchange time, last snapshot hash).

Connection comes from the DATABASE_URL environment variable, e.g.
  postgresql://user:password@host:5432/warehouse
A single connection guarded by a lock is plenty at this scale (the local app
uses the same pattern); calls reconnect once if Postgres dropped an idle
connection, which managed/serverless Postgres does after a while.
"""

import base64
import binascii
import os
import re
import secrets
import threading
from datetime import datetime, timezone

import psycopg
from psycopg.rows import dict_row

# Installed from packages/contract via requirements.txt (a relative-path
# pip install), the same on Vercel and locally -- no more dual import.
from contract import sync_contract

# On serverless hosting (Vercel), each function instance opens its own
# connection, so DATABASE_URL must be the POOLED connection string the
# provider gives you (Vercel Postgres/Neon call it "pooled"); a direct URL
# exhausts Postgres connection slots under concurrent requests.
DATABASE_URL = os.environ.get("DATABASE_URL", "")

REQUEST_PENDING = "pending"
# staging = the warehouse manager is scanning boxes for the request right now.
REQUEST_STATUSES = ("pending", "staging", "fulfilled", "declined")

# Mirror tables (tags/vendors/notes/bol_docs/events) are NOT in this schema:
# their DDL is generated from the sync contract (sync_contract.py, shared
# with the .exe) by _mirror_ddl(). Types stay permissive TEXT/INTEGER -- the
# .exe owns validation. This schema holds only the cloud-owned tables.
SCHEMA = """
CREATE TABLE IF NOT EXISTS requests (
    id           BIGSERIAL PRIMARY KEY,
    item_type    TEXT NOT NULL,
    quantity     INTEGER NOT NULL DEFAULT 1,
    building     TEXT NOT NULL DEFAULT '',
    jobsite      TEXT NOT NULL DEFAULT '',
    requester    TEXT NOT NULL DEFAULT '',
    contact      TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   TEXT NOT NULL DEFAULT '',
    handled_at   TEXT NOT NULL DEFAULT '',
    handler_note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);
-- Cart orders: lines submitted together share an order_ref (short hex).
ALTER TABLE requests ADD COLUMN IF NOT EXISTS order_ref TEXT NOT NULL DEFAULT '';
-- Requests carry the component name too, so W.I.F. accessories are requested
-- (and stock-checked) per component rather than as one pooled type.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS item_name TEXT NOT NULL DEFAULT '';
-- BOL PDF binaries, pushed separately from the row snapshot (the exchange
-- ack lists which bol_docs ids are still missing their file). Keyed by the
-- .exe's bol_docs id; label QR codes resolve through /tag/{epc} -> /bol/{id}.
CREATE TABLE IF NOT EXISTS bol_files (
    id          BIGINT PRIMARY KEY,
    filename    TEXT NOT NULL DEFAULT '',
    data        BYTEA NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT ''
);
"""

# How many missing BOL PDFs to ask the .exe for per exchange (bounds the
# follow-up upload's size; remaining ids are requested on later cycles).
BOL_FILES_WANTED_LIMIT = 5

# Unknown incoming columns (a newer .exe syncing against this older cloud)
# are auto-added as TEXT so no data is dropped during version skew -- but
# only names that look like plain SQL identifiers; anything else is ignored.
_SAFE_IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")


def _mirror_ddl():
    """DDL for the mirror tables, generated from the sync contract.

    CREATE TABLE for fresh databases, plus ADD COLUMN IF NOT EXISTS for each
    contract column so an existing deployment migrates itself on startup --
    this replaces the hand-patched ALTER list that used to lag the .exe
    (sector and item_name both shipped late that way).
    """
    stmts = []
    for table, cols in sync_contract.MIRROR_TABLES.items():
        defs = ", ".join(f"{name} {ctype}" for name, ctype in cols)
        stmts.append(f"CREATE TABLE IF NOT EXISTS {table} ({defs})")
        for name, ctype in cols:
            stmts.append(f"ALTER TABLE {table} "
                         f"ADD COLUMN IF NOT EXISTS {name} {ctype}")
    ev_defs = ", ".join(
        f"{name} {ctype}" + (" PRIMARY KEY" if name == "id" else "")
        for name, ctype in sync_contract.EVENT_COLUMNS)
    stmts.append(f"CREATE TABLE IF NOT EXISTS events ({ev_defs})")
    for name, ctype in sync_contract.EVENT_COLUMNS:
        stmts.append(f"ALTER TABLE events "
                     f"ADD COLUMN IF NOT EXISTS {name} {ctype}")
    stmts.append("CREATE INDEX IF NOT EXISTS idx_tags_type ON tags (item_type)")
    return stmts


def _extra_columns(rows, known):
    """Column names present in incoming rows but not in the contract,
    filtered to safe identifiers (lenient skew handling: store, don't drop)."""
    extras = set()
    for r in rows:
        extras.update(r.keys())
    extras.difference_update(known)
    return tuple(sorted(c for c in extras if _SAFE_IDENT.match(c)))


def _now():
    # UTC with an explicit offset (e.g. 2026-07-17T15:12:00+00:00). The cloud
    # host runs in UTC, so a naive datetime.now() would write UTC wall-clock
    # digits with no marker; the .exe UI then reads them as local time and the
    # clock appears hours ahead. Emitting the offset lets each viewer's
    # new Date()/toLocaleString convert to their own zone correctly.
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _parse_quantity(value):
    """Strict positive-int parse; None means invalid (callers reject, never
    silently clamp -- a mistyped quantity should bounce, not become 1)."""
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return None
    return n if n >= 1 else None


def _new_order_ref():
    """Short, human-readable order id shared by the lines of one cart."""
    return secrets.token_hex(3).upper()


class CloudDatabase:
    def __init__(self, url=None):
        self.url = url or DATABASE_URL
        if not self.url:
            raise RuntimeError(
                "DATABASE_URL is not set (postgresql://user:pass@host/db)")
        self._lock = threading.Lock()
        self._conn = None
        self._connect()
        self._create_schema()

    def _connect(self):
        self._conn = psycopg.connect(self.url, row_factory=dict_row,
                                     autocommit=False)

    def _cursor(self):
        """Cursor on a live connection, reconnecting once if PG dropped it."""
        try:
            return self._conn.cursor()
        except psycopg.OperationalError:
            self._connect()
            return self._conn.cursor()

    def _run(self, fn):
        """Serialize + wrap one unit of work in a transaction, with a single
        reconnect-and-retry for dropped idle connections."""
        with self._lock:
            for attempt in (1, 2):
                try:
                    with self._cursor() as cur:
                        result = fn(cur)
                    self._conn.commit()
                    return result
                except psycopg.OperationalError:
                    try:
                        self._conn.close()
                    except Exception:  # noqa: BLE001
                        pass
                    if attempt == 2:
                        raise
                    self._connect()
                except Exception:
                    # A failed statement leaves the transaction aborted;
                    # without a rollback the connection would reject every
                    # later query ("current transaction is aborted").
                    try:
                        self._conn.rollback()
                    except Exception:  # noqa: BLE001
                        pass
                    raise

    def _create_schema(self):
        def work(cur):
            for stmt in _mirror_ddl():
                cur.execute(stmt)
            cur.execute(SCHEMA)
        self._run(work)

    def close(self):
        with self._lock:
            try:
                self._conn.close()
            except Exception:  # noqa: BLE001
                pass

    # -- sync meta -------------------------------------------------------------
    def meta_get(self, key, default=""):
        def work(cur):
            cur.execute("SELECT value FROM sync_meta WHERE key=%s", (key,))
            row = cur.fetchone()
            return row["value"] if row else default
        return self._run(work)

    def _meta_set(self, cur, key, value):
        cur.execute(
            "INSERT INTO sync_meta (key, value) VALUES (%s, %s) "
            "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
            (key, str(value)))

    # -- the sync exchange -------------------------------------------------------
    def apply_exchange(self, payload):
        """Apply one exchange from the .exe in a single transaction.

        Returns the ack dict the .exe uses to advance its watermarks. Every
        step is idempotent, so a retried exchange is harmless.
        """
        def work(cur):
            # 1. Snapshot: wholesale replace of the mirror tables (carries
            #    edits and deletes for free). Only sent when content changed.
            snapshot = payload.get("snapshot")
            if snapshot:
                for table in sync_contract.SNAPSHOT_TABLES:
                    rows = snapshot.get(table) or []
                    cur.execute(f"DELETE FROM {table}")
                    if rows:
                        cols = self._insert_columns(cur, table,
                                                    sync_contract.columns(table),
                                                    rows)
                        placeholders = ",".join(["%s"] * len(cols))
                        sql = (f"INSERT INTO {table} ({', '.join(cols)}) "
                               f"VALUES ({placeholders})")
                        cur.executemany(
                            sql, [tuple(r.get(c) for c in cols) for r in rows])
                # Drop stored PDFs whose document was deleted on the .exe.
                cur.execute("DELETE FROM bol_files WHERE id NOT IN "
                            "(SELECT id FROM bol_docs)")
                self._meta_set(cur, "snapshot_hash",
                               payload.get("snapshot_hash") or "")

            # 2. Events: append-only, keyed by the .exe's row id. The ack
            #    tells the .exe where to resume; if our table is behind the
            #    .exe's watermark (e.g. this DB was rebuilt), ack low so it
            #    rewinds and re-pushes the missing tail.
            events_after = int(payload.get("events_after") or 0)
            cur.execute("SELECT COALESCE(MAX(id), 0) AS n FROM events")
            had_to = cur.fetchone()["n"]
            events = payload.get("events") or []
            if events:
                # Leniency matters most here: events are acked once and never
                # re-pushed, so a dropped column would be lost permanently.
                cols = self._insert_columns(
                    cur, "events",
                    sync_contract.columns(sync_contract.EVENTS_TABLE), events)
                placeholders = ",".join(["%s"] * len(cols))
                cur.executemany(
                    f"INSERT INTO events ({', '.join(cols)}) "
                    f"VALUES ({placeholders}) ON CONFLICT (id) DO NOTHING",
                    [tuple(e.get(c) for c in cols) for e in events])
            pushed_to = max([int(e["id"]) for e in events], default=events_after)
            if had_to >= events_after:
                events_acked_to = max(events_after, pushed_to)
            else:
                events_acked_to = had_to  # we're missing the tail: rewind

            # 3. Request status updates from the manager. Unknown ids are
            #    acked too, so the .exe stops resending them.
            updates = payload.get("request_updates") or []
            acked_updates = []
            for u in updates:
                try:
                    rid = int(u["id"])
                except (KeyError, TypeError, ValueError):
                    continue
                status = u.get("status")
                if status in REQUEST_STATUSES:
                    cur.execute(
                        "UPDATE requests SET status=%s, handled_at=%s, "
                        "handler_note=%s WHERE id=%s",
                        (status, str(u.get("handled_at") or ""),
                         str(u.get("handler_note") or ""), rid))
                acked_updates.append(rid)

            # 4. Pull: new requests above the .exe's watermark.
            requests_after = int(payload.get("requests_after") or 0)
            cur.execute(
                "SELECT * FROM requests WHERE id > %s ORDER BY id LIMIT 200",
                (requests_after,))
            new_requests = cur.fetchall()

            # 5. BOL PDFs this mirror is still missing; the .exe follows up
            #    with POST /sync/bol_files (see sync.py). Asked for again on
            #    every cycle until stored, so a failed upload self-heals.
            cur.execute(
                "SELECT d.id FROM bol_docs d "
                "LEFT JOIN bol_files f ON f.id = d.id "
                "WHERE f.id IS NULL ORDER BY d.id LIMIT %s",
                (BOL_FILES_WANTED_LIMIT,))
            bol_files_wanted = [r["id"] for r in cur.fetchall()]

            self._meta_set(cur, "last_exchange_at", _now())
            cur.execute("SELECT value FROM sync_meta WHERE key='snapshot_hash'")
            row = cur.fetchone()
            return {
                "ok": True,
                # Our contract version; the .exe compares it to its own and
                # shows a (non-fatal) skew warning on mismatch.
                "contract_hash": sync_contract.contract_hash(),
                "snapshot_hash": row["value"] if row else "",
                "events_acked_to": events_acked_to,
                "request_updates_acked": acked_updates,
                "requests": new_requests,
                "bol_files_wanted": bol_files_wanted,
            }
        return self._run(work)

    @staticmethod
    def _insert_columns(cur, table, contract_cols, rows):
        """Contract columns plus any unknown incoming ones, which are added
        to the table as TEXT first (lenient skew: a newer .exe's new column
        is stored, not dropped, until this deployment catches up)."""
        extras = _extra_columns(rows, set(contract_cols))
        for name in extras:
            cur.execute(f"ALTER TABLE {table} "
                        f"ADD COLUMN IF NOT EXISTS {name} TEXT")
            # The column is TEXT; Postgres won't cast an integer parameter
            # into it, so stringify non-null values up front.
            for r in rows:
                if r.get(name) is not None and not isinstance(r[name], str):
                    r[name] = str(r[name])
        return tuple(contract_cols) + extras

    def store_bol_files(self, files):
        """Store BOL PDFs pushed by the .exe ({id, filename, data} rows,
        data base64). Idempotent upsert; malformed entries are skipped."""
        def work(cur):
            stored = []
            for f in files or []:
                try:
                    doc_id = int(f["id"])
                    data = base64.b64decode(f["data"], validate=True)
                except (KeyError, TypeError, ValueError, binascii.Error):
                    continue
                if not data.startswith(b"%PDF-"):
                    continue
                cur.execute(
                    "INSERT INTO bol_files (id, filename, data, uploaded_at) "
                    "VALUES (%s, %s, %s, %s) "
                    "ON CONFLICT (id) DO UPDATE SET filename=EXCLUDED.filename, "
                    "data=EXCLUDED.data, uploaded_at=EXCLUDED.uploaded_at",
                    (doc_id, str(f.get("filename") or ""), data, _now()))
                stored.append(doc_id)
            return {"ok": True, "stored": stored}
        return self._run(work)

    def get_bol_file(self, doc_id):
        """One stored BOL PDF: {bol_number, filename, data} or None."""
        def work(cur):
            cur.execute(
                "SELECT f.filename, f.data, COALESCE(d.bol_number, '') AS bol_number "
                "FROM bol_files f LEFT JOIN bol_docs d ON d.id = f.id "
                "WHERE f.id = %s", (doc_id,))
            return cur.fetchone()
        return self._run(work)

    def tag_details(self, epc):
        """One mirrored tag for the QR landing page, with its BOL document
        reference and whether that document's PDF is stored here."""
        def work(cur):
            cur.execute(
                "SELECT t.*, d.bol_number AS doc_bol_number, "
                "       (f.id IS NOT NULL) AS bol_file_available "
                "FROM tags t "
                "LEFT JOIN bol_docs d ON d.id = t.bol_doc_id "
                "LEFT JOIN bol_files f ON f.id = t.bol_doc_id "
                "WHERE UPPER(t.epc) = UPPER(%s)", (str(epc or "").strip(),))
            return cur.fetchone()
        return self._run(work)

    # -- site reads ---------------------------------------------------------------
    def inventory_summary(self):
        """Item type -> groups (BOL x building) with units still in the
        warehouse, for the read-only site view. Mirrors the shape of the
        .exe's inventory tree, deliberately simplified."""
        def work(cur):
            cur.execute(
                """
                SELECT item_type,
                       bol_number,
                       building,
                       vendor,
                       COALESCE(SUM(remaining), 0) AS units,
                       COUNT(*)                    AS boxes,
                       MIN(received_at)            AS first_received
                FROM tags
                WHERE COALESCE(remaining, 0) > 0
                GROUP BY item_type, bol_number, building, vendor
                ORDER BY item_type, bol_number, building
                """)
            rows = cur.fetchall()
            return rows
        rows = self._run(work)
        types = {}
        for r in rows:
            t = types.setdefault(r["item_type"], {
                "item_type": r["item_type"], "units": 0, "boxes": 0,
                "groups": []})
            t["units"] += r["units"] or 0
            t["boxes"] += r["boxes"] or 0
            t["groups"].append(r)
        return list(types.values())

    def stock_rows(self):
        """Requestable stock for the cart view. Only stock actually on hand
        appears -- an item type with zero remaining units simply isn't
        requestable.

        Plain types: one row per item type x building (units summed across
        BOLs), each with its BOL breakdown ("groups") for the drill-down.

        Named types (any type whose in-stock boxes carry a per-box component
        name, e.g. W.I.F.): ONE row for the whole type, mirroring the .exe's
        warehouse view. Its drill-down is "components" -- one entry per
        component name x building with units, BOLs, first check-in and
        status -- and each component (not the type row) is what gets
        requested, so requests keep carrying item_name."""
        def work(cur):
            cur.execute(
                """
                SELECT item_type,
                       COALESCE(item_name, '')  AS item_name,
                       COALESCE(building, '')   AS building,
                       bol_number,
                       vendor,
                       COALESCE(SUM(remaining), 0) AS units,
                       COALESCE(SUM(quantity), 0)  AS capacity,
                       COUNT(*)                    AS boxes,
                       MIN(received_at)            AS first_received
                FROM tags
                WHERE COALESCE(remaining, 0) > 0
                GROUP BY item_type, COALESCE(item_name, ''),
                         COALESCE(building, ''), bol_number, vendor
                ORDER BY item_type, COALESCE(item_name, ''),
                         COALESCE(building, ''), bol_number
                """)
            return cur.fetchall()
        rows = self._run(work)
        named_types = {r["item_type"] for r in rows if r["item_name"]}
        stock = {}
        components = {}
        for r in rows:
            named = r["item_type"] in named_types
            key = ((r["item_type"],) if named
                   else (r["item_type"], "", r["building"]))
            row = stock.setdefault(key, {
                "item_type": r["item_type"], "item_name": "",
                "named": named,
                "building": "" if named else r["building"],
                "buildings": [],
                "units": 0, "boxes": 0, "vendors": [],
                "oldest_received": "", "groups": [], "components": []})
            row["units"] += r["units"] or 0
            row["boxes"] += r["boxes"] or 0
            if r["vendor"] and r["vendor"] not in row["vendors"]:
                row["vendors"].append(r["vendor"])
            if r["building"] and r["building"] not in row["buildings"]:
                row["buildings"].append(r["building"])
            first = (r["first_received"] or "")
            if first and (not row["oldest_received"]
                          or first < row["oldest_received"]):
                row["oldest_received"] = first
            if not named:
                row["groups"].append({
                    "bol_number": r["bol_number"], "vendor": r["vendor"],
                    "units": r["units"], "boxes": r["boxes"],
                    "first_received": r["first_received"]})
                continue
            ckey = (r["item_type"], r["item_name"], r["building"])
            comp = components.get(ckey)
            if comp is None:
                comp = {"item_name": r["item_name"],
                        "building": r["building"],
                        "units": 0, "capacity": 0, "boxes": 0,
                        "bol_numbers": [], "vendors": [],
                        "first_received": ""}
                components[ckey] = comp
                row["components"].append(comp)
            comp["units"] += r["units"] or 0
            comp["capacity"] += r["capacity"] or 0
            comp["boxes"] += r["boxes"] or 0
            if r["bol_number"] and r["bol_number"] not in comp["bol_numbers"]:
                comp["bol_numbers"].append(r["bol_number"])
            if r["vendor"] and r["vendor"] not in comp["vendors"]:
                comp["vendors"].append(r["vendor"])
            if first and (not comp["first_received"]
                          or first < comp["first_received"]):
                comp["first_received"] = first
        for comp in components.values():
            # Same wording as the .exe: a component whose boxes are all full
            # is In Warehouse; some units already drawn makes it Partial.
            comp["status"] = ("In Warehouse"
                              if comp["units"] == comp["capacity"]
                              else "Partial")
        return list(stock.values())

    def buildings(self):
        """Known delivery buildings: every building the mirror has ever seen
        (a valid destination doesn't need stock on hand)."""
        def work(cur):
            cur.execute(
                "SELECT DISTINCT COALESCE(building, '') AS b FROM tags "
                "WHERE COALESCE(building, '') != '' ORDER BY b")
            return [r["b"] for r in cur.fetchall()]
        return self._run(work)

    def counts(self):
        """Header numbers for the site: units in warehouse, open requests
        (pending or being staged by the warehouse)."""
        def work(cur):
            cur.execute(
                "SELECT COALESCE(SUM(remaining), 0) AS units FROM tags")
            units = cur.fetchone()["units"]
            cur.execute(
                "SELECT COUNT(*) AS n FROM requests "
                "WHERE status IN ('pending', 'staging')")
            pending = cur.fetchone()["n"]
            return {"units": units, "requests_pending": pending}
        return self._run(work)

    # -- requests (cloud-owned) ------------------------------------------------
    @staticmethod
    def _available_units(cur, item_type, item_name="", stock_building=None):
        """Units on hand for an item type + component name ('' for types
        without component names), optionally scoped to the building the stock
        is assigned to ('' = unassigned). Runs on the caller's cursor so
        checks and inserts share one transaction."""
        where = ["item_type=%s", "COALESCE(item_name, '')=%s",
                 "COALESCE(remaining, 0) > 0"]
        params = [item_type, item_name or ""]
        if stock_building is not None:
            where.append("COALESCE(building, '')=%s")
            params.append(stock_building)
        cur.execute(
            "SELECT COALESCE(SUM(remaining), 0) AS n FROM tags "
            f"WHERE {' AND '.join(where)}", params)
        return cur.fetchone()["n"] or 0

    @classmethod
    def _validate_line(cls, cur, item_type, quantity, item_name="",
                       stock_building=None):
        """One requested line against the mirrored stock. Returns an error
        message, or None when the line is fulfillable as asked."""
        if not item_type:
            return "An item type is required."
        qty = _parse_quantity(quantity)
        if qty is None:
            return "Quantity must be a whole number of 1 or more."
        available = cls._available_units(cur, item_type, item_name,
                                         stock_building)
        label = f"{item_type} | {item_name}" if item_name else item_type
        where = (f" in Building {stock_building}" if stock_building else "")
        if available <= 0:
            return f"No {label} in stock{where} right now."
        if qty > available:
            return (f"Only {available} unit(s) of {label} "
                    f"available{where}; requested {qty}.")
        return None

    def create_request(self, item_type, quantity, building="", jobsite="",
                       requester="", contact="", note="", item_name=""):
        """Single-line request (legacy JSON API). Availability is checked
        across all buildings -- this path has no stock-row context."""
        item_type = (item_type or "").strip()
        item_name = (item_name or "").strip()
        requester = (requester or "").strip()
        if not requester:
            return {"ok": False, "message": "Your name is required."}

        def work(cur):
            error = self._validate_line(cur, item_type, quantity, item_name)
            if error:
                return {"ok": False, "message": error}
            cur.execute(
                "INSERT INTO requests (item_type, item_name, quantity, "
                "building, jobsite, requester, contact, note, status, "
                "created_at, order_ref) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
                (item_type, item_name, _parse_quantity(quantity),
                 (building or "").strip(), (jobsite or "").strip(),
                 requester, (contact or "").strip(), (note or "").strip(),
                 REQUEST_PENDING, _now(), _new_order_ref()))
            return {"ok": True, "row": cur.fetchone()}
        result = self._run(work)
        if not result["ok"]:
            return result
        row = result["row"]
        return {"ok": True, "message": f"Request #{row['id']} submitted.",
                "request": row}

    def create_cart_request(self, requester, contact, jobsite, note,
                            delivery_building, lines):
        """One submitted cart -> N request rows sharing an order_ref, in a
        single all-or-nothing transaction.

        `lines` is a list of {item_type, item_name, building, quantity,
        delivery_building} where `building` is the STOCK row the requester
        picked ('' = unassigned stock) and `item_name` is the component name
        for named types like W.I.F. ('' otherwise); every line is checked
        against that stock's availability. Each line's `delivery_building`
        is where that line should go (stored on its row); the order-level
        `delivery_building` argument is a legacy fallback for lines that
        don't carry their own.

        Returns {ok, order_ref, ids} or {ok: False, message, errors:
        [{line, message}]} with `line` an index into `lines`.
        """
        requester = (requester or "").strip()
        delivery_building = (delivery_building or "").strip()
        lines = lines or []
        if not requester:
            return {"ok": False, "message": "Your name is required.",
                    "errors": []}
        if not lines:
            return {"ok": False, "message": "The cart is empty.", "errors": []}

        def work(cur):
            errors = []
            # Per-line checks (shape, quantity, delivery), then per stock-row
            # aggregate checks so two lines drawing on the same (type,
            # building) can't each pass individually while jointly exceeding
            # availability.
            parsed = []
            for i, line in enumerate(lines):
                item_type = str(line.get("item_type") or "").strip()
                item_name = str(line.get("item_name") or "").strip()
                stock_building = str(line.get("building") or "").strip()
                deliver_to = (str(line.get("delivery_building") or "").strip()
                              or delivery_building)
                qty = _parse_quantity(line.get("quantity"))
                if not item_type:
                    errors.append({"line": i,
                                   "message": "An item type is required."})
                elif qty is None:
                    errors.append({"line": i, "message":
                                   "Quantity must be a whole number of 1 "
                                   "or more."})
                elif not deliver_to:
                    errors.append({"line": i, "message":
                                   "A delivery building is required for "
                                   "this item."})
                else:
                    parsed.append((i, item_type, item_name, stock_building,
                                   qty, deliver_to))
            groups = {}
            for i, item_type, item_name, stock_building, qty, deliver_to in parsed:
                g = groups.setdefault((item_type, item_name, stock_building),
                                      {"total": 0, "lines": []})
                g["total"] += qty
                g["lines"].append(i)
            for (item_type, item_name, stock_building), g in groups.items():
                message = self._validate_line(cur, item_type, g["total"],
                                              item_name, stock_building)
                if message:
                    errors.extend({"line": i, "message": message}
                                  for i in g["lines"])
            if errors:
                errors.sort(key=lambda e: e["line"])
                return {"ok": False, "errors": errors,
                        "message": "Some items can't be fulfilled as "
                                   "requested."}

            order_ref = _new_order_ref()
            ts = _now()
            ids = []
            for i, item_type, item_name, stock_building, qty, deliver_to in parsed:
                cur.execute(
                    "INSERT INTO requests (item_type, item_name, quantity, "
                    "building, jobsite, requester, contact, note, status, "
                    "created_at, order_ref) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                    (item_type, item_name, qty, deliver_to,
                     (jobsite or "").strip(), requester,
                     (contact or "").strip(), (note or "").strip(),
                     REQUEST_PENDING, ts, order_ref))
                ids.append(cur.fetchone()["id"])
            return {"ok": True, "order_ref": order_ref, "ids": ids,
                    "message": (f"Order {order_ref} submitted "
                                f"({len(ids)} item{'s' if len(ids) != 1 else ''}).")}
        return self._run(work)

    def list_requests(self, limit=100):
        def work(cur):
            cur.execute(
                "SELECT * FROM requests ORDER BY "
                "CASE status WHEN 'staging' THEN 0 WHEN 'pending' THEN 0 "
                "ELSE 1 END, id DESC LIMIT %s", (limit,))
            return cur.fetchall()
        return self._run(work)

    def list_orders(self, limit=100):
        """Requests grouped into orders for the status page. Lines sharing an
        order_ref group together; legacy rows (no ref) stand alone. Open
        orders (any line pending/staging) first, then newest."""
        rows = self.list_requests(limit)
        orders = {}
        for r in rows:
            key = r["order_ref"] or f"request-{r['id']}"
            o = orders.setdefault(key, {
                "order_ref": r["order_ref"], "lines": [],
                "requester": r["requester"], "contact": r["contact"],
                "jobsite": r["jobsite"], "building": r["building"],
                "created_at": r["created_at"], "open": False,
                "max_id": 0})
            o["lines"].append(r)
            o["open"] = o["open"] or r["status"] in ("pending", "staging")
            o["max_id"] = max(o["max_id"], r["id"])
        result = list(orders.values())
        for o in result:
            o["lines"].sort(key=lambda r: r["id"])
            # Delivery building is per line; surface it on the order header
            # only when every line agrees (lines show their own otherwise).
            buildings = {r["building"] for r in o["lines"]}
            o["building"] = buildings.pop() if len(buildings) == 1 else ""
        result.sort(key=lambda o: (not o["open"], -o["max_id"]))
        return result
