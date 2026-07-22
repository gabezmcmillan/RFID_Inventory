/**
 * Bill-of-lading document repository (db.py:505-673).
 *
 * File deletion on disk is the caller's job in the new world: `deleteBolDoc`
 * returns the filename instead of unlinking (no `os.remove` equivalent here).
 */

import { desc, eq, sql } from "drizzle-orm";

import type { DomainDb } from "../db";
import { withTransaction } from "../db";
import { bolDocs, tags } from "../schema";
import type {
  BolDoc,
  BolDocWithBoxes,
  BolLineItem,
  DeleteBolDocResult,
  RenameBolDocResult,
} from "../types";
import { logEvent } from "./events";
import { now } from "./util";

/** Raw `bol_docs` row shape (inferred from the Drizzle schema). */
type BolDocRow = typeof bolDocs.$inferSelect;

function parseLineItems(raw: string): BolLineItem[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    const entries = parsed as Array<Record<string, unknown>>;
    return entries.map((e) => ({
      item_no: String(e["item_no"] ?? ""),
      item_name: String(e["item_name"] ?? ""),
      quantity: String(e["quantity"] ?? ""),
    })) as BolLineItem[];
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
  db: DomainDb,
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
  const inserted = await db
    .insert(bolDocs)
    .values({
      bol_number: bolNumber,
      filename,
      source,
      pages,
      vendor,
      po_number: poNumber,
      ocr_text: ocrText,
      line_items: JSON.stringify(lineItems ?? []),
      created_at: ts,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("createBolDoc: insert returned no row");
  const parts: string[] = [];
  if (vendor) parts.push(`vendor ${vendor}`);
  if (poNumber) parts.push(`PO ${poNumber}`);
  const extracted = parts.join(", ");
  let detail = `${source}: ${filename} (${pages} page(s))`;
  if (extracted) detail += `; OCR: ${extracted}`;
  await logEvent(db, "BOL_SCAN", "", "", bolNumber, "", vendor, detail);
  return bolDocDict(row);
}

/** Fetch one BOL doc, or null (db.py:534-538). */
export async function getBolDoc(db: DomainDb, docId: number): Promise<BolDoc | null> {
  const rows = await db.select().from(bolDocs).where(eq(bolDocs.id, docId));
  return rows[0] ? bolDocDict(rows[0]) : null;
}

/** BOL documents (newest first), each with its linked box count (db.py:540-560). */
export async function listBolDocs(db: DomainDb, limit = 15): Promise<BolDocWithBoxes[]> {
  const boxes = sql<number>`(SELECT COUNT(*) FROM ${tags} WHERE ${tags.bol_doc_id} = ${bolDocs.id})`;
  const rows = await db
    .select({
      id: bolDocs.id,
      bol_number: bolDocs.bol_number,
      filename: bolDocs.filename,
      source: bolDocs.source,
      pages: bolDocs.pages,
      vendor: bolDocs.vendor,
      po_number: bolDocs.po_number,
      ocr_text: bolDocs.ocr_text,
      line_items: bolDocs.line_items,
      auto_named: bolDocs.auto_named,
      created_at: bolDocs.created_at,
      storage_url: bolDocs.storage_url,
      boxes,
    })
    .from(bolDocs)
    .orderBy(desc(bolDocs.id))
    .limit(limit ?? 0);
  return rows.map((r) => ({ ...bolDocDict(r), boxes: r.boxes }));
}

/** Admin: delete a BOL document row; boxes keep their BOL number (db.py:562-594). */
export async function deleteBolDoc(db: DomainDb, docId: number): Promise<DeleteBolDocResult> {
  const rows = await db.select().from(bolDocs).where(eq(bolDocs.id, docId));
  const row = rows[0];
  if (!row) return { ok: false, message: `BOL document ${docId} not found.`, unlinked: 0, id: docId };

  let unlinked = 0;
  await withTransaction(db, async () => {
    const cur = await db
      .update(tags)
      .set({ bol_doc_id: null, updated_at: now() })
      .where(eq(tags.bol_doc_id, docId));
    unlinked = cur.changes;
    await db.delete(bolDocs).where(eq(bolDocs.id, docId));
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
  db: DomainDb,
  docId: number,
  newNumber: string,
): Promise<RenameBolDocResult> {
  const clean = (newNumber ?? "").toString().trim();
  if (!clean) return { ok: false, message: "BOL number cannot be empty." };
  const rows = await db.select().from(bolDocs).where(eq(bolDocs.id, docId));
  const row = rows[0];
  if (!row) return { ok: false, message: `BOL document ${docId} not found.` };

  const old = row.bol_number;
  let updated = 0;
  await withTransaction(db, async () => {
    await db.update(bolDocs).set({ bol_number: clean, auto_named: 0 }).where(eq(bolDocs.id, docId));
    const cur = await db
      .update(tags)
      .set({ bol_number: clean, updated_at: now() })
      .where(eq(tags.bol_doc_id, docId));
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

  const refreshed = await db.select().from(bolDocs).where(eq(bolDocs.id, docId));
  return {
    ok: true,
    message: `BOL renamed to '${clean}'.`,
    doc: refreshed[0] ? bolDocDict(refreshed[0]) : undefined,
    tags_updated: updated,
  };
}

/** Update the stored page count after an Add-page rescan (db.py:625-630). */
export async function setBolDocPages(db: DomainDb, docId: number, pages: number): Promise<void> {
  await db.update(bolDocs).set({ pages }).where(eq(bolDocs.id, docId));
}

/**
 * Fold a re-run OCR extraction into the document (db.py:632-673).
 *
 * Non-destructive: the BOL number is replaced only while still
 * machine-generated (auto_named); vendor/PO/line items fill in only if still
 * empty. ocr_text is always refreshed.
 */
export async function applyBolExtraction(
  db: DomainDb,
  docId: number,
  bolNumber = "",
  vendor = "",
  poNumber = "",
  ocrText = "",
  lineItems: BolLineItem[] | null = null,
): Promise<BolDoc | null> {
  const rows = await db.select().from(bolDocs).where(eq(bolDocs.id, docId));
  const row = rows[0];
  if (!row) return null;

  await withTransaction(db, async () => {
    await db.update(bolDocs).set({ ocr_text: ocrText }).where(eq(bolDocs.id, docId));
    const li = row.line_items || "[]";
    if (lineItems && lineItems.length > 0 && (li === "" || li === "[]")) {
      await db.update(bolDocs).set({ line_items: JSON.stringify(lineItems) }).where(eq(bolDocs.id, docId));
    }
    if (vendor && !row.vendor) {
      await db.update(bolDocs).set({ vendor }).where(eq(bolDocs.id, docId));
    }
    if (poNumber && !row.po_number) {
      await db.update(bolDocs).set({ po_number: poNumber }).where(eq(bolDocs.id, docId));
    }
    if (bolNumber && row.auto_named !== 0 && bolNumber !== row.bol_number) {
      await db.update(bolDocs).set({ bol_number: bolNumber }).where(eq(bolDocs.id, docId));
      await db
        .update(tags)
        .set({ bol_number: bolNumber, updated_at: now() })
        .where(eq(tags.bol_doc_id, docId));
    }
  });

  const refreshed = await db.select().from(bolDocs).where(eq(bolDocs.id, docId));
  return refreshed[0] ? bolDocDict(refreshed[0]) : null;
}
