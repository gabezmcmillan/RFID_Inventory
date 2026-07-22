/**
 * Admin repository: `updateTag` (db.py:1218-1295), `clearFlag` (db.py:1297-1315),
 * `deleteGroup` (db.py:1178-1211), `clearAll` (db.py:1154-1176).
 *
 * `clearAll` returns the BOL filenames so the caller can delete them from
 * storage (no `os.remove` here).
 */

import { EDITABLE_FIELDS, GROUP_COLUMNS, NAMED_ITEM_TYPES, STATUS_DELIVERED, STATUS_IN, STATUS_PARTIAL } from "../constants.js";
import type { SqlDatabase } from "../sql.js";
import { withTransaction } from "../sql.js";
import type { ClearAllResult, ClearFlagResult, DeleteGroupResult, Tag, TagRow, UpdateTagResult } from "../types.js";
import { logEvent } from "./events.js";
import { asQuantity, now, tagDict } from "./util.js";

/** Admin-editable fields keyed by string (values are strings/numbers as supplied). */
export type UpdateTagFields = Record<string, unknown>;

/** Admin: overwrite editable fields on a tag (db.py:1218-1295). */
export async function updateTag(
  db: SqlDatabase,
  epc: string,
  fields: UpdateTagFields,
): Promise<UpdateTagResult> {
  const upper = epc.toUpperCase();
  const ts = now();

  return withTransaction(db, async () => {
    const row = await db.get<TagRow>("SELECT * FROM tags WHERE epc=?", [upper]);
    if (!row) return { ok: false, message: `${upper} is not registered.`, epc: upper };

    const sets: string[] = [];
    const params: unknown[] = [];
    const changes: string[] = [];
    let statusInSets = false;
    const newQuantity = "quantity" in fields ? asQuantity(fields["quantity"]) : row.quantity;

    for (const key of EDITABLE_FIELDS) {
      if (!(key in fields)) continue;
      let newVal: string | number;
      if (key === "quantity") {
        newVal = newQuantity;
      } else if (key === "remaining") {
        let n = asQuantity(fields["remaining"], 0);
        if (n < 0) n = 0;
        newVal = Math.min(n, newQuantity);
      } else {
        const v = fields[key];
        newVal = (v === null || v === undefined ? "" : String(v)).trim();
      }
      const oldStr = String(row[key] ?? "");
      if (String(newVal) !== oldStr) {
        sets.push(`${key}=?`);
        if (key === "status") statusInSets = true;
        params.push(newVal);
        changes.push(`${key}: '${row[key]}' -> '${newVal}'`);
      }
    }

    if ("status" in fields && !("remaining" in fields)) {
      if (fields["status"] === STATUS_IN) {
        sets.push("remaining=?", "delivered_at=?", "flag=?", "flagged_at=?");
        params.push(newQuantity, "", "", "");
      } else if (fields["status"] === STATUS_DELIVERED) {
        sets.push("remaining=?");
        params.push(0);
        if (!row.delivered_at) {
          sets.push("delivered_at=?");
          params.push(ts);
        }
      }
    } else if ("remaining" in fields) {
      let n = asQuantity(fields["remaining"], 0);
      if (n < 0) n = 0;
      const newRemaining = Math.min(n, newQuantity);
      const derived =
        newRemaining === 0
          ? STATUS_DELIVERED
          : newRemaining === newQuantity
            ? STATUS_IN
            : STATUS_PARTIAL;
      if (!statusInSets) {
        sets.push("status=?");
        params.push(derived);
      }
      if (derived === STATUS_DELIVERED && !row.delivered_at) {
        sets.push("delivered_at=?");
        params.push(ts);
      } else if (derived === STATUS_IN) {
        sets.push("delivered_at=?", "flag=?", "flagged_at=?");
        params.push("", "", "");
      }
    }

    if (sets.length === 0) {
      return { ok: true, message: "No changes.", tag: tagDict(row) } satisfies UpdateTagResult;
    }

    sets.push("updated_at=?");
    params.push(ts, upper);
    await db.run(`UPDATE tags SET ${sets.join(", ")} WHERE epc=?`, params);
    const itemTypeForLog =
      fields["item_type"] !== undefined ? String(fields["item_type"]) : row.item_type;
    await logEvent(
      db,
      "EDIT",
      upper,
      itemTypeForLog,
      "",
      "",
      "",
      changes.join("; ") || "status/flag reset",
    );

    const updated = await db.get<TagRow>("SELECT * FROM tags WHERE epc=?", [upper]);
    return { ok: true, message: `Updated ${upper}.`, tag: updated ? tagDict(updated) : undefined };
  });
}

/** Admin: clear a tag's warning flag (db.py:1297-1315). */
export async function clearFlag(db: SqlDatabase, epc: string): Promise<ClearFlagResult> {
  const upper = epc.toUpperCase();
  const ts = now();

  return withTransaction(db, async () => {
    const row = await db.get<TagRow>("SELECT * FROM tags WHERE epc=?", [upper]);
    if (!row) return { ok: false, message: `${upper} is not registered.`, epc: upper };
    await db.run(
      "UPDATE tags SET flag=?, flagged_at=?, updated_at=? WHERE epc=?",
      ["", "", ts, upper],
    );
    await logEvent(db, "UNFLAG", upper, row.item_type);
    const updated = await db.get<TagRow>("SELECT * FROM tags WHERE epc=?", [upper]);
    return { ok: true, message: `Cleared flag on ${upper}.`, tag: updated ? tagDict(updated) : undefined };
  });
}

/** Admin: delete every tag in one (item_type, group) cell (db.py:1178-1211). */
export async function deleteGroup(
  db: SqlDatabase,
  itemType: string,
  groupBy: string,
  value: string,
): Promise<DeleteGroupResult> {
  const gcol = NAMED_ITEM_TYPES.includes(itemType)
    ? "item_name"
    : GROUP_COLUMNS[groupBy] ?? "bol_number";
  const label =
    NAMED_ITEM_TYPES.includes(itemType)
      ? "Item Name"
      : gcol === "building"
        ? "Building"
        : "BOL";
  const blank = value || "(blank)";

  return withTransaction(db, async () => {
    const row = await db.get<{ boxes: number; units: number }>(
      `SELECT COUNT(*) AS boxes, COALESCE(SUM(remaining), 0) AS units FROM tags WHERE item_type=? AND ${gcol}=?`,
      [itemType, value],
    );
    const boxes = row?.boxes ?? 0;
    const units = row?.units ?? 0;
    if (!boxes) {
      return {
        ok: false,
        removed: 0,
        message: `No ${itemType} boxes found for ${label} '${blank}'.`,
      } satisfies DeleteGroupResult;
    }
    await db.run(`DELETE FROM tags WHERE item_type=? AND ${gcol}=?`, [itemType, value]);
    await logEvent(
      db,
      "DELETE",
      "",
      itemType,
      gcol === "bol_number" ? value : "",
      gcol === "building" ? value : "",
      "",
      `deleted group ${label} '${blank}': ${boxes} box(es), ${units} unit(s)`,
    );
    return {
      ok: true,
      removed: boxes,
      message: `Deleted ${boxes} box(es) of ${itemType} (${label} '${blank}').`,
    } satisfies DeleteGroupResult;
  });
}

/** Admin: delete every tag and BOL document; events kept as audit trail (db.py:1154-1176). */
export async function clearAll(db: SqlDatabase): Promise<ClearAllResult> {
  return withTransaction(db, async () => {
    const countRow = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tags");
    const removed = countRow?.n ?? 0;
    const docRows = await db.all<{ filename: string }>("SELECT filename FROM bol_docs");
    const bolFiles = docRows.map((r) => r.filename);
    await db.run("DELETE FROM tags");
    await db.run("DELETE FROM bol_docs");
    await db.run("DELETE FROM notes");
    await logEvent(
      db,
      "CLEAR",
      "",
      "",
      "",
      "",
      "",
      `cleared ${removed} tag(s), ${bolFiles.length} BOL document(s)`,
    );
    return {
      ok: true,
      removed,
      bol_files: bolFiles,
      message: `Cleared ${removed} tag(s) from the database.`,
    } satisfies ClearAllResult;
  });
}
