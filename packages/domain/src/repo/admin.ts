/**
 * Admin repository: `updateTag` (db.py:1218-1295), `clearFlag` (db.py:1297-1315),
 * `deleteGroup` (db.py:1178-1211), `clearAll` (db.py:1154-1176).
 *
 * `clearAll` returns the BOL filenames so the caller can delete them from
 * storage (no `os.remove` here).
 */

import { and, count, eq, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import {
  EDITABLE_FIELDS,
  GROUP_COLUMNS,
  NAMED_ITEM_TYPES,
  STATUS_DELIVERED,
  STATUS_IN,
  STATUS_PARTIAL,
} from "../constants.js";
import type { DomainDb } from "../db.js";
import { withTransaction } from "../db.js";
import { bolDocs, notes, tags } from "../schema.js";
import type {
  ClearAllResult,
  ClearFlagResult,
  DeleteGroupResult,
  UpdateTagResult,
} from "../types.js";
import { logEvent } from "./events.js";
import { asQuantity, now, tagDict } from "./util.js";

/** Admin-editable fields keyed by string (values are strings/numbers as supplied). */
export type UpdateTagFields = Record<string, unknown>;

/** Map a whitelisted group column name to its Drizzle column on `tags`. */
const GROUP_COLUMN_MAP: Record<string, AnySQLiteColumn> = {
  bol_number: tags.bol_number,
  building: tags.building,
  item_name: tags.item_name,
};

/** Admin: overwrite editable fields on a tag (db.py:1218-1295). */
export async function updateTag(
  db: DomainDb,
  epc: string,
  fields: UpdateTagFields,
): Promise<UpdateTagResult> {
  const upper = epc.toUpperCase();
  const ts = now();

  return withTransaction(db, async () => {
    const rows = await db.select().from(tags).where(eq(tags.epc, upper));
    const row = rows[0];
    if (!row) return { ok: false, message: `${upper} is not registered.`, epc: upper };

    const setFragments: SQL[] = [];
    const changes: string[] = [];
    let statusInSets = false;
    const newQuantity = "quantity" in fields ? asQuantity(fields["quantity"]) : row.quantity;

    const setCol = (col: string, value: string | number): void => {
      setFragments.push(sql`${sql.raw(col)} = ${value}`);
    };

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
        setCol(key, newVal);
        if (key === "status") statusInSets = true;
        changes.push(`${key}: '${row[key]}' -> '${newVal}'`);
      }
    }

    if ("status" in fields && !("remaining" in fields)) {
      if (fields["status"] === STATUS_IN) {
        setCol("remaining", newQuantity);
        setCol("delivered_at", "");
        setCol("flag", "");
        setCol("flagged_at", "");
      } else if (fields["status"] === STATUS_DELIVERED) {
        setCol("remaining", 0);
        if (!row.delivered_at) setCol("delivered_at", ts);
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
      if (!statusInSets) setCol("status", derived);
      if (derived === STATUS_DELIVERED && !row.delivered_at) {
        setCol("delivered_at", ts);
      } else if (derived === STATUS_IN) {
        setCol("delivered_at", "");
        setCol("flag", "");
        setCol("flagged_at", "");
      }
    }

    if (setFragments.length === 0) {
      return { ok: true, message: "No changes.", tag: tagDict(row) } satisfies UpdateTagResult;
    }

    setCol("updated_at", ts);
    await db.run(sql`UPDATE tags SET ${sql.join(setFragments, sql`, `)} WHERE epc = ${upper}`);
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

    const updated = await db.select().from(tags).where(eq(tags.epc, upper));
    return { ok: true, message: `Updated ${upper}.`, tag: updated[0] ? tagDict(updated[0]) : undefined };
  });
}

/** Admin: clear a tag's warning flag (db.py:1297-1315). */
export async function clearFlag(db: DomainDb, epc: string): Promise<ClearFlagResult> {
  const upper = epc.toUpperCase();
  const ts = now();

  return withTransaction(db, async () => {
    const rows = await db.select().from(tags).where(eq(tags.epc, upper));
    const row = rows[0];
    if (!row) return { ok: false, message: `${upper} is not registered.`, epc: upper };
    await db.update(tags).set({ flag: "", flagged_at: "", updated_at: ts }).where(eq(tags.epc, upper));
    await logEvent(db, "UNFLAG", upper, row.item_type);
    const updated = await db.select().from(tags).where(eq(tags.epc, upper));
    return { ok: true, message: `Cleared flag on ${upper}.`, tag: updated[0] ? tagDict(updated[0]) : undefined };
  });
}

/** Admin: delete every tag in one (item_type, group) cell (db.py:1178-1211). */
export async function deleteGroup(
  db: DomainDb,
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
  const col = GROUP_COLUMN_MAP[gcol] ?? tags.bol_number;

  return withTransaction(db, async () => {
    const agg = await db
      .select({
        boxes: count(),
        units: sql<number>`COALESCE(SUM(${tags.remaining}), 0)`,
      })
      .from(tags)
      .where(and(eq(tags.item_type, itemType), eq(col, value)));
    const boxes = agg[0]?.boxes ?? 0;
    const units = agg[0]?.units ?? 0;
    if (!boxes) {
      return {
        ok: false,
        removed: 0,
        message: `No ${itemType} boxes found for ${label} '${blank}'.`,
      } satisfies DeleteGroupResult;
    }
    await db.delete(tags).where(and(eq(tags.item_type, itemType), eq(col, value)));
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
export async function clearAll(db: DomainDb): Promise<ClearAllResult> {
  return withTransaction(db, async () => {
    const countRows = await db.select({ n: count() }).from(tags);
    const removed = countRows[0]?.n ?? 0;
    const docRows = await db.select({ filename: bolDocs.filename }).from(bolDocs);
    const bolFiles = docRows.map((r) => r.filename);
    await db.delete(tags);
    await db.delete(bolDocs);
    await db.delete(notes);
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
