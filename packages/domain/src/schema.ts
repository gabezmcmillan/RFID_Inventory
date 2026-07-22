/**
 * Database schema, ported 1:1 from `apps/warehouse/db.py:105-200` with the
 * post-migration columns folded in and the plan-002 changes applied:
 *
 *  - `tags.bol_doc_id INTEGER` (db.py migration, folded in).
 *  - `bol_docs.storage_url TEXT NOT NULL DEFAULT ''` (new: blob-storage
 *    location; plans 007/010 use it).
 *  - `requests` drops `status_dirty` (Turso syncs the row itself) and gains
 *    `updated_at TEXT NOT NULL DEFAULT ''`; `id` becomes AUTOINCREMENT since
 *    the web app now inserts requests directly.
 *  - `local_meta` (key/value) replaces `sync_state`, holding only the EPC
 *    serial and the device id.
 *
 * Identifiers, defaults, and `epc TEXT UNIQUE NOT NULL` are unchanged.
 */

export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS tags (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    epc          TEXT UNIQUE NOT NULL,
    item_type    TEXT NOT NULL,
    item_name    TEXT NOT NULL DEFAULT '',
    bol_number   TEXT NOT NULL DEFAULT '',
    po_number    TEXT NOT NULL DEFAULT '',
    building     TEXT NOT NULL DEFAULT '',
    sector       TEXT NOT NULL DEFAULT '',
    vendor       TEXT NOT NULL DEFAULT '',
    sku          TEXT NOT NULL DEFAULT '',
    mfc_date     TEXT NOT NULL DEFAULT '',
    quantity     INTEGER NOT NULL DEFAULT 1,
    remaining    INTEGER NOT NULL DEFAULT 1,
    status       TEXT NOT NULL DEFAULT 'In Warehouse',
    received_at  TEXT NOT NULL,
    delivered_at TEXT NOT NULL DEFAULT '',
    checkout_building TEXT NOT NULL DEFAULT '',
    flag         TEXT NOT NULL DEFAULT '',
    flagged_at   TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    bol_doc_id   INTEGER
);

CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    action    TEXT NOT NULL,
    epc       TEXT,
    item_type TEXT,
    bol_number TEXT,
    building  TEXT,
    vendor    TEXT,
    detail    TEXT
);

CREATE TABLE IF NOT EXISTS vendors (
    name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS bol_docs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    bol_number TEXT NOT NULL,
    filename   TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'scan',
    pages      INTEGER NOT NULL DEFAULT 1,
    vendor     TEXT NOT NULL DEFAULT '',
    po_number  TEXT NOT NULL DEFAULT '',
    ocr_text   TEXT NOT NULL DEFAULT '',
    line_items TEXT NOT NULL DEFAULT '[]',
    auto_named INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    storage_url TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    item_type  TEXT NOT NULL,
    bol_number TEXT NOT NULL DEFAULT '',
    building   TEXT NOT NULL DEFAULT '',
    text       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type    TEXT NOT NULL,
    item_name    TEXT NOT NULL DEFAULT '',
    quantity     INTEGER NOT NULL DEFAULT 1,
    building     TEXT NOT NULL DEFAULT '',
    jobsite      TEXT NOT NULL DEFAULT '',
    requester    TEXT NOT NULL DEFAULT '',
    contact      TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   TEXT NOT NULL DEFAULT '',
    handled_at   TEXT NOT NULL DEFAULT '',
    handler_note TEXT NOT NULL DEFAULT '',
    order_ref    TEXT NOT NULL DEFAULT '',
    updated_at   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS local_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_group
    ON notes (item_type, bol_number, building);
CREATE INDEX IF NOT EXISTS idx_tags_group
    ON tags (item_type, bol_number, building);
CREATE INDEX IF NOT EXISTS idx_tags_status ON tags (status);
CREATE INDEX IF NOT EXISTS idx_events_action ON events (action);
CREATE INDEX IF NOT EXISTS idx_events_epc ON events (epc);
`;

import type { SqlDatabase } from "./sql.js";

/** Apply the schema (idempotent) to a fresh or existing database. */
export async function applySchema(db: SqlDatabase): Promise<void> {
  await db.exec(SCHEMA_SQL);
}
