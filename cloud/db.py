"""
Postgres layer for the cloud app (Azure Database for PostgreSQL).

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
connection, which Azure does after a while.
"""

import os
import secrets
import threading
from datetime import datetime

import psycopg
from psycopg.rows import dict_row

# On serverless hosting (Vercel), each function instance opens its own
# connection, so DATABASE_URL must be the POOLED connection string the
# provider gives you (Vercel Postgres/Neon call it "pooled"); a direct URL
# exhausts Postgres connection slots under concurrent requests.
DATABASE_URL = os.environ.get("DATABASE_URL", "")

REQUEST_PENDING = "pending"
# staging = the warehouse manager is scanning boxes for the request right now.
REQUEST_STATUSES = ("pending", "staging", "fulfilled", "declined")

# Mirror-table columns, matching what the .exe's export_snapshot() sends
# (db.py schema on the local side). Snapshot apply is a wholesale replace, so
# types stay permissive TEXT/INTEGER -- the .exe owns validation.
MIRROR_COLUMNS = {
    "tags": ("id", "epc", "item_type", "bol_number", "po_number", "building",
             "vendor", "sku", "mfc_date", "quantity", "remaining", "status",
             "received_at", "delivered_at", "checkout_building", "flag",
             "flagged_at", "created_at", "updated_at", "bol_doc_id"),
    "vendors": ("name",),
    "notes": ("id", "ts", "item_type", "bol_number", "building", "text"),
    "bol_docs": ("id", "bol_number", "filename", "source", "pages", "vendor",
                 "po_number", "auto_named", "created_at"),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS tags (
    id                BIGINT,
    epc               TEXT,
    item_type         TEXT,
    bol_number        TEXT,
    po_number         TEXT,
    building          TEXT,
    vendor            TEXT,
    sku               TEXT,
    mfc_date          TEXT,
    quantity          INTEGER,
    remaining         INTEGER,
    status            TEXT,
    received_at       TEXT,
    delivered_at      TEXT,
    checkout_building TEXT,
    flag              TEXT,
    flagged_at        TEXT,
    created_at        TEXT,
    updated_at        TEXT,
    bol_doc_id        BIGINT
);
CREATE TABLE IF NOT EXISTS vendors (
    name TEXT
);
CREATE TABLE IF NOT EXISTS notes (
    id         BIGINT,
    ts         TEXT,
    item_type  TEXT,
    bol_number TEXT,
    building   TEXT,
    text       TEXT
);
CREATE TABLE IF NOT EXISTS bol_docs (
    id         BIGINT,
    bol_number TEXT,
    filename   TEXT,
    source     TEXT,
    pages      INTEGER,
    vendor     TEXT,
    po_number  TEXT,
    auto_named INTEGER,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
    id         BIGINT PRIMARY KEY,
    ts         TEXT,
    action     TEXT,
    epc        TEXT,
    item_type  TEXT,
    bol_number TEXT,
    building   TEXT,
    vendor     TEXT,
    detail     TEXT
);
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
CREATE INDEX IF NOT EXISTS idx_tags_type ON tags (item_type);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);
-- Cart orders: lines submitted together share an order_ref (short hex).
ALTER TABLE requests ADD COLUMN IF NOT EXISTS order_ref TEXT NOT NULL DEFAULT '';
"""


def _now():
    return datetime.now().isoformat(timespec="seconds")


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
        self._run(lambda cur: cur.execute(SCHEMA))

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
                for table, cols in MIRROR_COLUMNS.items():
                    rows = snapshot.get(table) or []
                    cur.execute(f"DELETE FROM {table}")
                    if rows:
                        placeholders = ",".join(["%s"] * len(cols))
                        sql = (f"INSERT INTO {table} ({', '.join(cols)}) "
                               f"VALUES ({placeholders})")
                        cur.executemany(
                            sql, [tuple(r.get(c) for c in cols) for r in rows])
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
                cols = ("id", "ts", "action", "epc", "item_type",
                        "bol_number", "building", "vendor", "detail")
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

            self._meta_set(cur, "last_exchange_at", _now())
            cur.execute("SELECT value FROM sync_meta WHERE key='snapshot_hash'")
            row = cur.fetchone()
            return {
                "ok": True,
                "snapshot_hash": row["value"] if row else "",
                "events_acked_to": events_acked_to,
                "request_updates_acked": acked_updates,
                "requests": new_requests,
            }
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
        """Requestable stock for the cart view: one row per item type x
        building (units summed across BOLs), each with its BOL breakdown for
        the drill-down. Only stock actually on hand appears -- an item type
        with zero remaining units simply isn't requestable."""
        def work(cur):
            cur.execute(
                """
                SELECT item_type,
                       COALESCE(building, '')   AS building,
                       bol_number,
                       vendor,
                       COALESCE(SUM(remaining), 0) AS units,
                       COUNT(*)                    AS boxes,
                       MIN(received_at)            AS first_received
                FROM tags
                WHERE COALESCE(remaining, 0) > 0
                GROUP BY item_type, COALESCE(building, ''), bol_number, vendor
                ORDER BY item_type, COALESCE(building, ''), bol_number
                """)
            return cur.fetchall()
        rows = self._run(work)
        stock = {}
        for r in rows:
            key = (r["item_type"], r["building"])
            row = stock.setdefault(key, {
                "item_type": r["item_type"], "building": r["building"],
                "units": 0, "boxes": 0, "vendors": [],
                "oldest_received": "", "groups": []})
            row["units"] += r["units"] or 0
            row["boxes"] += r["boxes"] or 0
            if r["vendor"] and r["vendor"] not in row["vendors"]:
                row["vendors"].append(r["vendor"])
            first = (r["first_received"] or "")
            if first and (not row["oldest_received"]
                          or first < row["oldest_received"]):
                row["oldest_received"] = first
            row["groups"].append({
                "bol_number": r["bol_number"], "vendor": r["vendor"],
                "units": r["units"], "boxes": r["boxes"],
                "first_received": r["first_received"]})
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
    def _available_units(cur, item_type, stock_building=None):
        """Units on hand for an item type, optionally scoped to the building
        the stock is assigned to ('' = unassigned). Runs on the caller's
        cursor so checks and inserts share one transaction."""
        if stock_building is None:
            cur.execute(
                "SELECT COALESCE(SUM(remaining), 0) AS n FROM tags "
                "WHERE item_type=%s AND COALESCE(remaining, 0) > 0",
                (item_type,))
        else:
            cur.execute(
                "SELECT COALESCE(SUM(remaining), 0) AS n FROM tags "
                "WHERE item_type=%s AND COALESCE(building, '')=%s "
                "AND COALESCE(remaining, 0) > 0",
                (item_type, stock_building))
        return cur.fetchone()["n"] or 0

    @classmethod
    def _validate_line(cls, cur, item_type, quantity, stock_building=None):
        """One requested line against the mirrored stock. Returns an error
        message, or None when the line is fulfillable as asked."""
        if not item_type:
            return "An item type is required."
        qty = _parse_quantity(quantity)
        if qty is None:
            return "Quantity must be a whole number of 1 or more."
        available = cls._available_units(cur, item_type, stock_building)
        where = (f" in Building {stock_building}" if stock_building else "")
        if available <= 0:
            return f"No {item_type} in stock{where} right now."
        if qty > available:
            return (f"Only {available} unit(s) of {item_type} "
                    f"available{where}; requested {qty}.")
        return None

    def create_request(self, item_type, quantity, building="", jobsite="",
                       requester="", contact="", note=""):
        """Single-line request (legacy JSON API). Availability is checked
        across all buildings -- this path has no stock-row context."""
        item_type = (item_type or "").strip()
        requester = (requester or "").strip()
        if not requester:
            return {"ok": False, "message": "Your name is required."}

        def work(cur):
            error = self._validate_line(cur, item_type, quantity)
            if error:
                return {"ok": False, "message": error}
            cur.execute(
                "INSERT INTO requests (item_type, quantity, building, jobsite,"
                " requester, contact, note, status, created_at, order_ref) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
                (item_type, _parse_quantity(quantity),
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

        `lines` is a list of {item_type, building, quantity} where `building`
        is the STOCK row the requester picked ('' = unassigned stock); every
        line is checked against that stock's availability. `delivery_building`
        is where the whole order should go (stored on each row).

        Returns {ok, order_ref, ids} or {ok: False, message, errors:
        [{line, message}]} with `line` an index into `lines`.
        """
        requester = (requester or "").strip()
        delivery_building = (delivery_building or "").strip()
        lines = lines or []
        if not requester:
            return {"ok": False, "message": "Your name is required.",
                    "errors": []}
        if not delivery_building:
            return {"ok": False, "message": "A delivery building is required.",
                    "errors": []}
        if not lines:
            return {"ok": False, "message": "The cart is empty.", "errors": []}

        def work(cur):
            errors = []
            # Per-line checks (shape, quantity), then per stock-row aggregate
            # checks so two lines drawing on the same (type, building) can't
            # each pass individually while jointly exceeding availability.
            parsed = []
            for i, line in enumerate(lines):
                item_type = str(line.get("item_type") or "").strip()
                stock_building = str(line.get("building") or "").strip()
                qty = _parse_quantity(line.get("quantity"))
                if not item_type:
                    errors.append({"line": i,
                                   "message": "An item type is required."})
                elif qty is None:
                    errors.append({"line": i, "message":
                                   "Quantity must be a whole number of 1 "
                                   "or more."})
                else:
                    parsed.append((i, item_type, stock_building, qty))
            groups = {}
            for i, item_type, stock_building, qty in parsed:
                g = groups.setdefault((item_type, stock_building),
                                      {"total": 0, "lines": []})
                g["total"] += qty
                g["lines"].append(i)
            for (item_type, stock_building), g in groups.items():
                message = self._validate_line(cur, item_type, g["total"],
                                              stock_building)
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
            for i, item_type, stock_building, qty in parsed:
                cur.execute(
                    "INSERT INTO requests (item_type, quantity, building, "
                    "jobsite, requester, contact, note, status, created_at, "
                    "order_ref) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                    "RETURNING id",
                    (item_type, qty, delivery_building,
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
        result.sort(key=lambda o: (not o["open"], -o["max_id"]))
        return result
