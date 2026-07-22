/**
 * Database schema, as Drizzle `sqliteTable` definitions — the single source of
 * truth for the warehouse domain's tables, columns, defaults, constraints, and
 * indexes.
 *
 * Ported 1:1 from the previous hand-written DDL (itself ported from
 * `apps/warehouse/db.py:105-200` with the post-migration columns folded in and
 * the plan-002 changes applied):
 *
 *  - `tags.bol_doc_id INTEGER` (db.py migration, folded in).
 *  - `bol_docs.storage_url TEXT NOT NULL DEFAULT ''` (blob-storage location;
 *    plans 007/010 use it).
 *  - `requests` drops `status_dirty` (Turso syncs the row itself) and gains
 *    `updated_at TEXT NOT NULL DEFAULT ''`; `id` is AUTOINCREMENT since the web
 *    app now inserts requests directly.
 *  - `local_meta` (key/value) replaces `sync_state`, holding only the EPC
 *    serial and the device id.
 *
 * Column DB names are snake_case and identical to the legacy schema; the TS
 * property names are also snake_case so the inferred row types drop in for the
 * old hand-written row types without renaming anything downstream (the public
 * API in `src/index.ts` keeps stable names). Identifiers, defaults, and
 * `epc TEXT UNIQUE NOT NULL` are unchanged.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** `tags` — one RFID box. `epc` is globally unique; `bol_doc_id` is nullable. */
export const tags = sqliteTable(
  "tags",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    epc: text().notNull().unique(),
    item_type: text().notNull(),
    item_name: text().notNull().default(""),
    bol_number: text().notNull().default(""),
    po_number: text().notNull().default(""),
    building: text().notNull().default(""),
    sector: text().notNull().default(""),
    vendor: text().notNull().default(""),
    sku: text().notNull().default(""),
    mfc_date: text().notNull().default(""),
    quantity: integer().notNull().default(1),
    remaining: integer().notNull().default(1),
    status: text().notNull().default("In Warehouse"),
    received_at: text().notNull(),
    delivered_at: text().notNull().default(""),
    checkout_building: text().notNull().default(""),
    flag: text().notNull().default(""),
    flagged_at: text().notNull().default(""),
    created_at: text().notNull(),
    updated_at: text().notNull(),
    bol_doc_id: integer(),
  },
  (t) => [
    index("idx_tags_group").on(t.item_type, t.bol_number, t.building),
    index("idx_tags_status").on(t.status),
  ],
);

/** `events` — append-only audit log; every column after `action` is nullable. */
export const events = sqliteTable(
  "events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    ts: text().notNull(),
    action: text().notNull(),
    epc: text(),
    item_type: text(),
    bol_number: text(),
    building: text(),
    vendor: text(),
    detail: text(),
  },
  (t) => [index("idx_events_action").on(t.action), index("idx_events_epc").on(t.epc)],
);

/** `vendors` — the operator-managed vendor picklist. */
export const vendors = sqliteTable("vendors", {
  name: text().primaryKey(),
});

/**
 * `bol_docs` — a scanned/uploaded bill-of-lading document. `line_items` is a
 * JSON-encoded `BolLineItem[]`; `auto_named` is 0/1 (kept as an integer to
 * preserve the DDL); `storage_url` is the blob-storage location.
 */
export const bolDocs = sqliteTable("bol_docs", {
  id: integer().primaryKey({ autoIncrement: true }),
  bol_number: text().notNull(),
  filename: text().notNull(),
  source: text().notNull().default("scan"),
  pages: integer().notNull().default(1),
  vendor: text().notNull().default(""),
  po_number: text().notNull().default(""),
  ocr_text: text().notNull().default(""),
  line_items: text().notNull().default("[]"),
  auto_named: integer().notNull().default(1),
  created_at: text().notNull(),
  storage_url: text().notNull().default(""),
});

/** `notes` — timestamped free-text notes attached to a shipment group. */
export const notes = sqliteTable(
  "notes",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    ts: text().notNull(),
    item_type: text().notNull(),
    bol_number: text().notNull().default(""),
    building: text().notNull().default(""),
    text: text().notNull(),
  },
  (t) => [index("idx_notes_group").on(t.item_type, t.bol_number, t.building)],
);

/**
 * `requests` — material requests. The web app inserts these (status `pending`);
 * the warehouse device resolves them. `id` is AUTOINCREMENT; `status_dirty` is
 * gone; `updated_at` is maintained on every status change.
 */
export const requests = sqliteTable("requests", {
  id: integer().primaryKey({ autoIncrement: true }),
  item_type: text().notNull(),
  item_name: text().notNull().default(""),
  quantity: integer().notNull().default(1),
  building: text().notNull().default(""),
  jobsite: text().notNull().default(""),
  requester: text().notNull().default(""),
  contact: text().notNull().default(""),
  note: text().notNull().default(""),
  status: text().notNull().default("pending"),
  created_at: text().notNull().default(""),
  handled_at: text().notNull().default(""),
  handler_note: text().notNull().default(""),
  order_ref: text().notNull().default(""),
  updated_at: text().notNull().default(""),
});

/** `local_meta` — key/value store for the EPC serial and the device id. */
export const localMeta = sqliteTable("local_meta", {
  key: text().primaryKey(),
  value: text().notNull(),
});

/** All Drizzle table definitions, for `drizzle({ schema })` and migrations. */
export const schema = { tags, events, vendors, bolDocs, notes, requests, localMeta };
