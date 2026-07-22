import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { importLegacy } from "../importLegacy.js";
import { openTursoDb } from "../../testing/openTestDb.js";

// Legacy DDL, copied from apps/warehouse/db.py:105-200 (base schema, no migration
// columns: no tags.bol_doc_id, no bol_docs.storage_url; requests keeps status_dirty;
// sync_state instead of local_meta).
const LEGACY_DDL = `
CREATE TABLE tags (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    epc          TEXT UNIQUE NOT NULL,
    item_type    TEXT NOT NULL,
    item_name    TEXT NOT NULL DEFAULT '',
    bol_number    TEXT NOT NULL DEFAULT '',
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
    updated_at   TEXT NOT NULL
);
CREATE TABLE events (
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
CREATE TABLE vendors (
    name TEXT PRIMARY KEY
);
CREATE TABLE bol_docs (
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
    created_at TEXT NOT NULL
);
CREATE TABLE notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    item_type  TEXT NOT NULL,
    bol_number TEXT NOT NULL DEFAULT '',
    building   TEXT NOT NULL DEFAULT '',
    text       TEXT NOT NULL
);
CREATE TABLE requests (
    id           INTEGER PRIMARY KEY,
    item_type    TEXT NOT NULL,
    item_name    TEXT NOT NULL DEFAULT '',
    quantity     INTEGER NOT NULL DEFAULT 1,
    building     TEXT NOT NULL DEFAULT '',
    jobsite      TEXT NOT NULL DEFAULT '',
    requester    TEXT NOT NULL DEFAULT '',
    contact       TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   TEXT NOT NULL DEFAULT '',
    handled_at   TEXT NOT NULL DEFAULT '',
    handler_note TEXT NOT NULL DEFAULT '',
    status_dirty INTEGER NOT NULL DEFAULT 0,
    order_ref    TEXT NOT NULL DEFAULT ''
);
CREATE TABLE sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX idx_notes_group ON notes (item_type, bol_number, building);
CREATE INDEX idx_tags_group ON tags (item_type, bol_number, building);
CREATE INDEX idx_tags_status ON tags (status);
CREATE INDEX idx_events_action ON events (action);
CREATE INDEX idx_events_epc ON events (epc);
`;

function tempFile(prefix: string): string {
  return join(
    tmpdir(),
    `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
  );
}

describe("importer", () => {
  let legacyPath: string;
  let targetPath: string;

  beforeEach(() => {
    legacyPath = tempFile("legacy");
    targetPath = tempFile("target");
  });

  afterEach(() => {
    if (existsSync(legacyPath)) Database(legacyPath).close();
  });

  test("copies every table preserving ids and seeds epc_serial from sync_state", async () => {
    const legacy = new Database(legacyPath);
    legacy.exec(LEGACY_DDL);
    legacy.prepare(
      "INSERT INTO tags (id, epc, item_type, bol_number, building, vendor, quantity, remaining, status, received_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(7, "42473031" + "000000000000000A", "TSC", "BOL1", "6", "Acme", 4, 3, "Partial", "2026-01-01T08:00:00", "2026-01-01T08:00:00", "2026-01-01T08:00:00");
    legacy.prepare("INSERT INTO events (id, ts, action, epc, item_type) VALUES (?,?,?,?,?)").run(1, "2026-01-01T08:00:00", "IN", "42473031" + "000000000000000A", "TSC");
    legacy.prepare("INSERT INTO vendors (name) VALUES (?)").run("Acme");
    legacy.prepare("INSERT INTO notes (id, ts, item_type, bol_number, building, text) VALUES (?,?,?,?,?,?)").run(1, "2026-01-01T08:00:00", "TSC", "BOL1", "6", "note text");
    legacy.prepare("INSERT INTO bol_docs (id, bol_number, filename, source, pages, created_at) VALUES (?,?,?,?,?,?)").run(3, "BOL1", "bol1.pdf", "scan", 2, "2026-01-01T08:00:00");
    legacy.prepare("INSERT INTO requests (id, item_type, quantity, status, status_dirty, order_ref) VALUES (?,?,?,?,?,?)").run(11, "TSC", 4, "pending", 1, "ORD-1");
    legacy.prepare("INSERT INTO sync_state (key, value) VALUES ('epc_serial', ?)").run("42");
    legacy.close();

    const report = await importLegacy(legacyPath, targetPath);
    for (const t of report.tables) {
      expect(t.legacy).toBe(t.imported);
    }
    expect(report.tables.find((t) => t.table === "tags")?.imported).toBe(1);
    expect(report.epcSerial).toBe(42);

    // Spot-check the tag round-trips with its id preserved.
    const target = await openTursoDb(targetPath);
    const tag = await target.get<{ id: number; epc: string; status: string; remaining: number; bol_doc_id: number | null }>(
      sql`SELECT id, epc, status, remaining, bol_doc_id FROM tags WHERE epc=${"42473031" + "000000000000000A"}`,
    );
    expect(tag?.id).toBe(7);
    expect(tag?.status).toBe("Partial");
    expect(tag?.remaining).toBe(3);
    expect(tag?.bol_doc_id).toBeNull(); // legacy had no bol_doc_id column

    // requests: status_dirty dropped, updated_at present.
    const req = await target.get<{ status_dirty?: number; updated_at: string; order_ref: string }>(
      sql`SELECT * FROM requests WHERE id=${11}`,
    );
    expect(req?.status_dirty).toBeUndefined();
    expect(req?.updated_at).toBe("");
    expect(req?.order_ref).toBe("ORD-1");

    // bol_docs: storage_url present and blank.
    const doc = await target.get<{ id: number; storage_url: string; pages: number }>(
      sql`SELECT id, storage_url, pages FROM bol_docs WHERE id=${3}`,
    );
    expect(doc?.id).toBe(3);
    expect(doc?.storage_url).toBe("");
    expect(doc?.pages).toBe(2);

    // local_meta seeded.
    const meta = await target.get<{ value: string }>(sql`SELECT value FROM local_meta WHERE key='epc_serial'`);
    expect(meta?.value).toBe("42");
  });

  test("seeds epc_serial from max prefix serial when sync_state is absent", async () => {
    const legacy = new Database(legacyPath);
    legacy.exec(LEGACY_DDL);
    legacy.prepare("INSERT INTO tags (epc, item_type, received_at, created_at, updated_at) VALUES (?,?,?,?,?)").run("42473031" + "000000000000000A", "TSC", "t", "t", "t");
    legacy.prepare("INSERT INTO tags (epc, item_type, received_at, created_at, updated_at) VALUES (?,?,?,?,?)").run("42473031" + "0000000000000064", "TSC", "t", "t", "t");
    legacy.close();

    const report = await importLegacy(legacyPath, targetPath);
    expect(report.epcSerial).toBe(0x64); // 100 in decimal
  });
});
