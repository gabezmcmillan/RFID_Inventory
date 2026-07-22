/**
 * Bill-of-lading document repository (db.py:505-673).
 *
 * File deletion on disk is the caller's job in the new world: `deleteBolDoc`
 * returns the filename instead of unlinking (no `os.remove` equivalent here).
 */

import type { SqlDatabase } from "../sql.js";
import { withTransaction } from "../sql.js";
import type {
  BolDoc,
  BolDocWithBoxes,
  BolLineItem,
  DeleteBolDocResult,
  RenameBolDocResult,
} from "../types.js";
import { logEvent } from "./events.js";
import { now } from "./util.js";

interface BolDocRow {
  id: number;
  bol_number: string;
  filename: string;
  source: string;
  pages: number;
  vendor: string;
  po_number: string;
  ocr_text: string;
  line_items: string;
  auto_named: number;
  created_at: string;
  storage_url: string;
}

function parseLineItems(raw: string): BolLineItem[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as BolLineItem[];
  } catch {
    return [];
  }
}

function bolDocDict(row: BolDocRow): BolDoc {
  return {
    id: row.id,
    bol_number: row.bol_number,
    filename: row.filename,
    source: row.source,
    pages: row.pages,
    vendor: row.vendor,
    po_number: row.po_number,
    line_items: parseLineItems(row.line_items),
    auto_named: row.auto_named !== 0,
    created_at: row.created_at,
    storage_url: row.storage_url,
  };
}

/** Register a scanned/uploaded BOL PDF and log a `BOL_SCAN` event (db.py:505-532). */
export async function createBolDoc(
  db: SqlDatabase,
  bolNumber: string,
  filename: string,
  source = "scan",
  pages = 1,
  vendor = "",
  poNumber = "",
  ocrText = "",
  lineItems: BolLineItem[] | null = null,
): Promise<BolDoc> {
  const ts = now();
  let docId = 0;
  await withTransaction(db, async () => {
    const res = await db.run(
      "INSERT INTO bol_docs (bol_number, filename, source, pages, vendor, po_number, ocr_text, line_items, created_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?)",
      [bolNumber, filename, source, pages, vendor, poNumber, ocrText, JSON.stringify(lineItems ?? []), ts],
    );
    docId = Number(res.lastInsertRowid);
    const parts: string[] = [];
    if (vendor) parts.push(`vendor ${vendor}`);
    if (poNumber) parts.push(`PO ${poNumber}`);
    const extracted = parts.join(", ");
    let detail = `${source}: ${filename} (${pages} page(s))`;
    if (extracted) detail += `; OCR: ${extracted}`;
    await logEvent(db, "BOL_SCAN", "", "", bolNumber, "", vendor, detail);
  });
  const row = await db.get<BolDocRow>("SELECT * FROM bol_docs WHERE id=?", [docId]);
  // `row` is always present immediately after a successful insert.
  return bolDocDict(row as BolDocRow);
}

/** Fetch one BOL doc, or null (db.py:534-538). */
export async function getBolDoc(db: SqlDatabase, docId: number): Promise<BolDoc | null> {
  const row = await db.get<BolDocRow>("SELECT * FROM bol_docs WHERE id=?", [docId]);
  return row ? bolDocDict(row) : null;
}

/** BOL documents (newest first), each with its linked box count (db.py:540-560). */
export async function listBolDocs(db: SqlDatabase, limit = 15): Promise<BolDocWithBoxes[]> {
  let sql =
    "SELECT d.*, (SELECT COUNT(*) FROM tags t WHERE t.bol_doc_id = d.id) AS boxes " +
    "FROM bol_docs d ORDER BY d.id DESC";
  const params: unknown[] = [];
  if (limit) {
    sql += " LIMIT ?";
    params.push(limit);
  }
  const rows = await db.all<BolDocRow & { boxes: number }>(sql, params);
  return rows.map((r) => ({ ...bolDocDict(r), boxes: r.boxes }));
}

/** Admin: delete a BOL document row; boxes keep their BOL number (db.py:562-594). */
export async function deleteBolDoc(db: SqlDatabase, docId: number): Promise<DeleteBolDocResult> {
  const row = await db.get<BolDocRow>("SELECT * FROM bol_docs WHERE id=?", [docId]);
  if (!row) return { ok: false, message: `BOL document ${docId} not found.`, unlinked: 0, id: docId };

  let unlinked = 0;
  await withTransaction(db, async () => {
    const cur = await db.run(
      "UPDATE tags SET bol_doc_id=NULL, updated_at=? WHERE bol_doc_id=?",
      [now(), docId],
    );
    unlinked = cur.changes;
    await db.run("DELETE FROM bol_docs WHERE id=?", [docId]);
    await logEvent(
      db,
      "BOL_DELETE",
      "",
      "",
      row.bol_number,
      "",
      "",
      `deleted document (${row.filename}, ${row.pages} page(s)); ${unlinked} box(es) unlinked`,
    );
  });

  let msg = `Deleted BOL '${row.bol_number}' and its PDF.`;
  if (unlinked) {
    msg += ` ${unlinked} box(es) keep their BOL number but no longer link to a document.`;
  }
  return { ok: true, message: msg, unlinked, id: docId, filename: row.filename };
}

/** Set a document's BOL number; tags filed under it follow (db.py:596-623). */
export async function renameBolDoc(
  db: SqlDatabase,
  docId: number,
  newNumber: string,
): Promise<RenameBolDocResult> {
  const clean = (newNumber ?? "").toString().trim();
  if (!clean) return { ok: false, message: "BOL number cannot be empty." };
  const row = await db.get<BolDocRow>("SELECT * FROM bol_docs WHERE id=?", [docId]);
  if (!row) return { ok: false, message: `BOL document ${docId} not found.` };

  const old = row.bol_number;
  let updated = 0;
  await withTransaction(db, async () => {
    await db.run("UPDATE bol_docs SET bol_number=?, auto_named=0 WHERE id=?", [clean, docId]);
    const cur = await db.run(
      "UPDATE tags SET bol_number=?, updated_at=? WHERE bol_doc_id=?",
      [clean, now(), docId],
    );
    updated = cur.changes;
    await logEvent(
      db,
      "BOL_RENAME",
      "",
      "",
      clean,
      "",
      "",
      `was '${old}'; ${updated} box(es) updated`,
    );
  });

  const refreshed = await db.get<BolDocRow>("SELECT * FROM bol_docs WHERE id=?", [docId]);
  return {
    ok: true,
    message: `BOL renamed to '${clean}'.`,
    doc: refreshed ? bolDocDict(refreshed) : undefined,
    tags_updated: updated,
  };
}

/** Update the stored page count after an Add-page rescan (db.py:625-630). */
export async function setBolDocPages(db: SqlDatabase, docId: number, pages: number): Promise<void> {
  await db.run("UPDATE bol_docs SET pages=? WHERE id=?", [pages, docId]);
}

/**
 * Fold a re-run OCR extraction into the document (db.py:632-673).
 *
 * Non-destructive: the BOL number is replaced only while still
 * machine-generated (auto_named); vendor/PO/line items fill in only if still
 * empty. ocr_text is always refreshed.
 */
export async function applyBolExtraction(
  db: SqlDatabase,
  docId: number,
  bolNumber = "",
  vendor = "",
  poNumber = "",
  ocrText = "",
  lineItems: BolLineItem[] | null = null,
): Promise<BolDoc | null> {
  const row = await db.get<BolDocRow>("SELECT * FROM bol_docs WHERE id=?", [docId]);
  if (!row) return null;

  await withTransaction(db, async () => {
    await db.run("UPDATE bol_docs SET ocr_text=? WHERE id=?", [ocrText, docId]);
    const li = row.line_items || "[]";
    if (lineItems && lineItems.length > 0 && (li === "" || li === "[]")) {
      await db.run("UPDATE bol_docs SET line_items=? WHERE id=?", [JSON.stringify(lineItems), docId]);
    }
    if (vendor && !row.vendor) {
      await db.run("UPDATE bol_docs SET vendor=? WHERE id=?", [vendor, docId]);
    }
    if (poNumber && !row.po_number) {
      await db.run("UPDATE bol_docs SET po_number=? WHERE id=?", [poNumber, docId]);
    }
    if (bolNumber && row.auto_named !== 0 && bolNumber !== row.bol_number) {
      await db.run("UPDATE bol_docs SET bol_number=? WHERE id=?", [bolNumber, docId]);
      await db.run("UPDATE tags SET bol_number=?, updated_at=? WHERE bol_doc_id=?", [bolNumber, now(), docId]);
    }
  });

  const refreshed = await db.get<BolDocRow>("SELECT * FROM bol_docs WHERE id=?", [docId]);
  return refreshed ? bolDocDict(refreshed) : null;
}
