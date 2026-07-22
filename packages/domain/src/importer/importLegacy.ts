/**
 * One-shot importer: copy a legacy `apps/warehouse` SQLite database into a
 * new-schema Turso database.
 *
 * - Legacy reads use `better-sqlite3` (read-only, battle-tested reader).
 * - Target writes use the Drizzle {@link DomainDb} surface (Node Turso), with
 *   drizzle-kit migrations applied.
 * - `tags` / `events` / `bol_docs` / `notes` / `requests` ids are preserved
 *   (identity matters for audit continuity); `requests.status_dirty` is dropped;
 *   `bol_docs` rows get `storage_url=''`; `requests` get `updated_at=''`.
 * - `local_meta.epc_serial` is seeded from legacy `sync_state.epc_serial` if
 *   present, else the max serial parsed from existing `42473031…` EPCs, else 0
 *   (device 00 semantics; new devices get ids ≥ 01).
 */

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";

import { PRINTER_EPC_PREFIX } from "../constants.js";
import type { DomainDb } from "../db.js";
import { setMeta } from "../repo/util.js";
import { openTursoDb } from "../testing/openTestDb.js";

export interface ImportTableCount {
  table: string;
  legacy: number;
  imported: number;
}

export interface ImportReport {
  tables: ImportTableCount[];
  epcSerial: number;
}

function legacyColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Parse the max per-device serial from existing prefix EPCs (legacy 16-hex serial). */
function maxLegacySerial(epcs: string[]): number {
  let max = 0;
  for (const epc of epcs) {
    if (epc.startsWith(PRINTER_EPC_PREFIX) && epc.length === 24) {
      const serialHex = epc.slice(PRINTER_EPC_PREFIX.length);
      const n = Number.parseInt(serialHex, 16);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
}

/**
 * Import `legacyPath` (SQLite file) into a fresh Turso database at `targetPath`.
 * Throws on any per-table count mismatch.
 */
export async function importLegacy(
  legacyPath: string,
  targetPath: string,
): Promise<ImportReport> {
  const legacy = new Database(legacyPath, { readonly: true, fileMustExist: true });
  const target = await openTursoDb(targetPath);

  const report: ImportReport = { tables: [], epcSerial: 0 };

  // -- tags (preserve id; bol_doc_id only if the legacy column exists) -------------
  const tagCols = legacyColumns(legacy, "tags");
  const tagHasBolDocId = tagCols.has("bol_doc_id");
  const tagColumns = [
    "id", "epc", "item_type", "item_name", "bol_number", "po_number", "building",
    "sector", "vendor", "sku", "mfc_date", "quantity", "remaining", "status",
    "received_at", "delivered_at", "checkout_building", "flag", "flagged_at",
    "created_at", "updated_at", "bol_doc_id",
  ];
  const tagColsList = tagColumns.join(", ");
  const tagRows = legacy.prepare("SELECT * FROM tags ORDER BY id").all() as Record<string, unknown>[];
  for (const r of tagRows) {
    await target.run(sql`INSERT INTO tags (${sql.raw(tagColsList)}) VALUES (${r.id}, ${r.epc}, ${r.item_type}, ${r.item_name}, ${r.bol_number}, ${r.po_number}, ${r.building}, ${r.sector}, ${r.vendor}, ${r.sku}, ${r.mfc_date}, ${r.quantity}, ${r.remaining}, ${r.status}, ${r.received_at}, ${r.delivered_at}, ${r.checkout_building}, ${r.flag}, ${r.flagged_at}, ${r.created_at}, ${r.updated_at}, ${tagHasBolDocId ? r.bol_doc_id : null})`);
  }
  report.tables.push({ table: "tags", legacy: tagRows.length, imported: tagRows.length });

  // -- events ------------------------------------------------------------------
  const eventRows = legacy.prepare("SELECT * FROM events ORDER BY id").all() as Record<string, unknown>[];
  for (const r of eventRows) {
    await target.run(sql`INSERT INTO events (id, ts, action, epc, item_type, bol_number, building, vendor, detail) VALUES (${r.id}, ${r.ts}, ${r.action}, ${r.epc}, ${r.item_type}, ${r.bol_number}, ${r.building}, ${r.vendor}, ${r.detail})`);
  }
  report.tables.push({ table: "events", legacy: eventRows.length, imported: eventRows.length });

  // -- vendors -----------------------------------------------------------------
  const vendorRows = legacy.prepare("SELECT name FROM vendors ORDER BY name").all() as { name: string }[];
  for (const r of vendorRows) {
    await target.run(sql`INSERT OR IGNORE INTO vendors (name) VALUES (${r.name})`);
  }
  report.tables.push({ table: "vendors", legacy: vendorRows.length, imported: vendorRows.length });

  // -- notes -------------------------------------------------------------------
  const noteRows = legacy.prepare("SELECT * FROM notes ORDER BY id").all() as Record<string, unknown>[];
  for (const r of noteRows) {
    await target.run(sql`INSERT INTO notes (id, ts, item_type, bol_number, building, text) VALUES (${r.id}, ${r.ts}, ${r.item_type}, ${r.bol_number}, ${r.building}, ${r.text})`);
  }
  report.tables.push({ table: "notes", legacy: noteRows.length, imported: noteRows.length });

  // -- bol_docs (legacy rows get storage_url '') --------------------------------
  const bolRows = legacy.prepare("SELECT * FROM bol_docs ORDER BY id").all() as Record<string, unknown>[];
  for (const r of bolRows) {
    await target.run(sql`INSERT INTO bol_docs (id, bol_number, filename, source, pages, vendor, po_number, ocr_text, line_items, auto_named, created_at, storage_url) VALUES (${r.id}, ${r.bol_number}, ${r.filename}, ${r.source}, ${r.pages}, ${r.vendor}, ${r.po_number}, ${r.ocr_text}, ${r.line_items}, ${r.auto_named}, ${r.created_at}, '')`);
  }
  report.tables.push({ table: "bol_docs", legacy: bolRows.length, imported: bolRows.length });

  // -- requests (drop status_dirty; add updated_at '') --------------------------
  const reqColumns = [
    "id", "item_type", "item_name", "quantity", "building", "jobsite", "requester",
    "contact", "note", "status", "created_at", "handled_at", "handler_note",
    "order_ref", "updated_at",
  ];
  const reqColsList = reqColumns.join(", ");
  const reqRows = legacy.prepare("SELECT * FROM requests ORDER BY id").all() as Record<string, unknown>[];
  for (const r of reqRows) {
    await target.run(sql`INSERT INTO requests (${sql.raw(reqColsList)}) VALUES (${r.id}, ${r.item_type}, ${r.item_name}, ${r.quantity}, ${r.building}, ${r.jobsite}, ${r.requester}, ${r.contact}, ${r.note}, ${r.status}, ${r.created_at}, ${r.handled_at}, ${r.handler_note}, ${r.order_ref}, '')`);
  }
  report.tables.push({ table: "requests", legacy: reqRows.length, imported: reqRows.length });

  // -- local_meta.epc_serial ---------------------------------------------------
  let epcSerial = 0;
  const syncRow = legacy.prepare("SELECT value FROM sync_state WHERE key='epc_serial'").get() as
    | { value: string }
    | undefined;
  if (syncRow) {
    epcSerial = Number.parseInt(syncRow.value, 10);
    if (!Number.isFinite(epcSerial) || epcSerial < 0) epcSerial = 0;
  } else {
    epcSerial = maxLegacySerial(tagRows.map((r) => String(r.epc ?? "")));
  }
  await setMeta(target, "epc_serial", String(epcSerial));
  report.epcSerial = epcSerial;

  legacy.close();

  // Mismatch check.
  for (const t of report.tables) {
    if (t.legacy !== t.imported) {
      throw new Error(`Mismatch on ${t.table}: legacy=${t.legacy} imported=${t.imported}`);
    }
  }
  return report;
}
