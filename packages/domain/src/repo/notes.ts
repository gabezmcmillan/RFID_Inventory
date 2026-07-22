/**
 * Note repository: `addNote`, `listNotes`, `deleteNote` (db.py:685-742).
 *
 * `listNotes` preserves the Python None-vs-'' filter semantics: an omitted
 * (undefined) filter skips the clause, while an empty string matches shipments
 * recorded with a blank value.
 */

import type { SqlDatabase } from "../sql.js";
import { withTransaction } from "../sql.js";
import type { AddNoteResult, DeleteNoteResult, Note } from "../types.js";
import { logEvent } from "./events.js";
import { now } from "./util.js";

interface NoteRow {
  id: number;
  ts: string;
  item_type: string;
  bol_number: string;
  building: string;
  text: string;
}

function noteDict(row: NoteRow): Note {
  return {
    id: row.id,
    ts: row.ts,
    item_type: row.item_type,
    bol_number: row.bol_number,
    building: row.building,
    text: row.text,
  };
}

/** Attach a timestamped note to a shipment and log a `NOTE` event (db.py:685-709). */
export async function addNote(
  db: SqlDatabase,
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
    const res = await db.run(
      "INSERT INTO notes (ts, item_type, bol_number, building, text) VALUES (?,?,?,?,?)",
      [ts, cleanType, cleanBol, cleanBuilding, cleanText],
    );
    noteId = Number(res.lastInsertRowid);
    const detail = cleanText.length <= 200 ? cleanText : cleanText.slice(0, 197) + "...";
    await logEvent(db, "NOTE", "", cleanType, cleanBol, cleanBuilding, "", detail);
  });

  const row = await db.get<NoteRow>("SELECT * FROM notes WHERE id=?", [noteId]);
  return { ok: true, message: "Note added.", note: row ? noteDict(row) : undefined };
}

/** Notes for a shipment, oldest first (db.py:711-729). */
export async function listNotes(
  db: SqlDatabase,
  itemType: string,
  bolNumber?: string | null,
  building?: string | null,
): Promise<Note[]> {
  const where = ["item_type = ?"];
  const params: unknown[] = [itemType];
  if (bolNumber !== undefined && bolNumber !== null) {
    where.push("bol_number = ?");
    params.push(bolNumber);
  }
  if (building !== undefined && building !== null) {
    where.push("building = ?");
    params.push(building);
  }
  const rows = await db.all<NoteRow>(
    `SELECT * FROM notes WHERE ${where.join(" AND ")} ORDER BY id`,
    params,
  );
  return rows.map(noteDict);
}

/** Admin: remove a note and log a `NOTE_DEL` event (db.py:731-742). */
export async function deleteNote(db: SqlDatabase, noteId: number): Promise<DeleteNoteResult> {
  const row = await db.get<NoteRow>("SELECT * FROM notes WHERE id=?", [noteId]);
  if (!row) return { ok: false, message: `Note ${noteId} not found.` };
  await withTransaction(db, async () => {
    await db.run("DELETE FROM notes WHERE id=?", [noteId]);
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
