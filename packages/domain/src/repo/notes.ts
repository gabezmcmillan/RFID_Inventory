/**
 * Note repository: `addNote`, `listNotes`, `deleteNote` (db.py:685-742).
 *
 * `listNotes` preserves the Python None-vs-'' filter semantics: an omitted
 * (undefined) filter skips the clause, while an empty string matches shipments
 * recorded with a blank value.
 */

import { and, asc, eq } from "drizzle-orm";

import type { DomainDb } from "../db.js";
import { withTransaction } from "../db.js";
import { notes } from "../schema.js";
import type { AddNoteResult, DeleteNoteResult, Note } from "../types.js";
import { logEvent } from "./events.js";
import { now } from "./util.js";

/** Attach a timestamped note to a shipment and log a `NOTE` event (db.py:685-709). */
export async function addNote(
  db: DomainDb,
  itemType: string,
  bolNumber: string,
  building: string,
  text: string,
): Promise<AddNoteResult> {
  const cleanText = (text ?? "").toString().trim();
  const cleanType = (itemType ?? "").toString().trim();
  if (!cleanText) return { ok: false, message: "Note text is required." };
  if (!cleanType) return { ok: false, message: "An item type is required." };
  const cleanBol = (bolNumber ?? "").toString().trim();
  const cleanBuilding = (building ?? "").toString().trim();
  const ts = now();

  let noteId = 0;
  await withTransaction(db, async () => {
    const inserted = await db
      .insert(notes)
      .values({ ts, item_type: cleanType, bol_number: cleanBol, building: cleanBuilding, text: cleanText })
      .returning({ id: notes.id });
    noteId = inserted[0]?.id ?? 0;
    const detail = cleanText.length <= 200 ? cleanText : cleanText.slice(0, 197) + "...";
    await logEvent(db, "NOTE", "", cleanType, cleanBol, cleanBuilding, "", detail);
  });

  const rows = await db.select().from(notes).where(eq(notes.id, noteId));
  return { ok: true, message: "Note added.", note: rows[0] };
}

/** Notes for a shipment, oldest first (db.py:711-729). */
export async function listNotes(
  db: DomainDb,
  itemType: string,
  bolNumber?: string | null,
  building?: string | null,
): Promise<Note[]> {
  const conds = [eq(notes.item_type, itemType)];
  if (bolNumber !== undefined && bolNumber !== null) conds.push(eq(notes.bol_number, bolNumber));
  if (building !== undefined && building !== null) conds.push(eq(notes.building, building));
  return db.select().from(notes).where(and(...conds)).orderBy(asc(notes.id));
}

/** Admin: remove a note and log a `NOTE_DEL` event (db.py:731-742). */
export async function deleteNote(db: DomainDb, noteId: number): Promise<DeleteNoteResult> {
  const rows = await db.select().from(notes).where(eq(notes.id, noteId));
  const row = rows[0];
  if (!row) return { ok: false, message: `Note ${noteId} not found.` };
  await withTransaction(db, async () => {
    await db.delete(notes).where(eq(notes.id, noteId));
    await logEvent(
      db,
      "NOTE_DEL",
      "",
      row.item_type,
      row.bol_number,
      row.building,
      "",
      row.text.slice(0, 200),
    );
  });
  return { ok: true, message: "Note deleted." };
}
