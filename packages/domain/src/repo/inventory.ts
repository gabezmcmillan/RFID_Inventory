/**
 * Inventory repository: sweeps, the interactive warehouse view, drill-down,
 * export, and the finder (db.py:859-1112).
 *
 * Dynamic identifiers (`group_by`) are mapped through the typed
 * `GROUP_COLUMNS` whitelist and never reach SQL from a caller string.
 */

import {
  GROUP_COLUMNS,
  NAMED_ITEM_TYPES,
  STATUS_DELIVERED,
  STATUS_IN,
  STATUS_PARTIAL,
} from "../constants.js";
import type { SqlDatabase } from "../sql.js";
import { withTransaction } from "../sql.js";
import type {
  CompareInventoryResult,
  FlaggedTag,
  GroupTagsResult,
  InventoryFilters,
  InventoryGroup,
  InventoryTreeResult,
  InventoryType,
  RecordInventoryResult,
  Tag,
  TagRow,
} from "../types.js";
import { logEvent } from "./events.js";
import { dateOf, now, tagDict } from "./util.js";

/** Shared warehouse-filter WHERE builder (db.py:926-955). */
function filterWhere(filters: InventoryFilters | null | undefined): {
  clause: string;
  params: unknown[];
} {
  const f = filters ?? {};
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.bol) {
    where.push("bol_number LIKE ?");
    params.push(`%${f.bol}%`);
  }
  if (f.building) {
    where.push("building = ?");
    params.push(String(f.building));
  }
  if (f.received_from) {
    where.push("substr(received_at, 1, 10) >= ?");
    params.push(f.received_from);
  }
  if (f.received_to) {
    where.push("substr(received_at, 1, 10) <= ?");
    params.push(f.received_to);
  }
  if (f.checked_out_from) {
    where.push("delivered_at != '' AND substr(delivered_at, 1, 10) >= ?");
    params.push(f.checked_out_from);
  }
  if (f.checked_out_to) {
    where.push("delivered_at != '' AND substr(delivered_at, 1, 10) <= ?");
    params.push(f.checked_out_to);
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  return { clause, params };
}

/** Inventory sweep (db.py:859-901). Read-only for quantities; logs `COUNT` per tag. */
export async function recordInventory(
  db: SqlDatabase,
  epcs: string[],
): Promise<RecordInventoryResult> {
  const counts: Record<string, number> = {};
  const unknown: string[] = [];
  const flagged: FlaggedTag[] = [];
  const items: Tag[] = [];
  const ts = now();

  const ordered = Array.from(new Set(epcs.map((e) => e.toUpperCase()))).sort();

  await withTransaction(db, async () => {
    for (const epc of ordered) {
      const row = await db.get<TagRow>("SELECT * FROM tags WHERE epc=?", [epc]);
      if (!row) {
        unknown.push(epc);
        await logEvent(db, "COUNT", epc, "UNKNOWN");
        continue;
      }
      items.push(tagDict(row));
      if (row.remaining <= 0) {
        const flag = `Checked out ${dateOf(row.delivered_at)}; detected in sweep`;
        await db.run(
          "UPDATE tags SET flag=?, flagged_at=?, updated_at=? WHERE epc=?",
          [flag, ts, ts, epc],
        );
        await logEvent(
          db,
          "FLAG",
          epc,
          row.item_type,
          row.bol_number,
          row.building,
          row.vendor,
          flag,
        );
        flagged.push({
          epc,
          item_type: row.item_type,
          bol_number: row.bol_number,
          building: row.building,
          delivered_at: dateOf(row.delivered_at),
          flag,
        });
      } else {
        counts[row.item_type] = (counts[row.item_type] ?? 0) + row.remaining;
        await logEvent(
          db,
          "COUNT",
          epc,
          row.item_type,
          row.bol_number,
          row.building,
          row.vendor,
          `${row.remaining} unit(s)`,
        );
      }
    }
  });

  const total =
    Object.values(counts).reduce((a, b) => a + b, 0) + unknown.length + flagged.length;
  return { counts, unknown, flagged, items, total };
}

/** Reconcile a sweep session against expected warehouse contents (db.py:903-923). */
export async function compareInventory(
  db: SqlDatabase,
  epcs: string[],
): Promise<CompareInventoryResult> {
  const scanned = new Set(epcs.map((e) => e.toUpperCase()));
  const rows = await db.all<TagRow>(
    "SELECT * FROM tags WHERE remaining > 0 ORDER BY item_type, bol_number, epc",
  );
  const foundEpcs: string[] = [];
  const missing: Tag[] = [];
  for (const row of rows) {
    if (scanned.has(row.epc)) {
      foundEpcs.push(row.epc);
    } else {
      missing.push(tagDict(row));
    }
  }
  return {
    expected: rows.length,
    found_count: foundEpcs.length,
    missing_count: missing.length,
    missing,
    found_epcs: foundEpcs,
  };
}

interface TreeRow {
  item_type: string;
  gval: string | null;
  oval: string | null;
  vendor: string;
  in_wh: number | null;
  capacity: number | null;
  boxes: number;
  flagged: number | null;
  first_received: string | null;
  doc_id: number | null;
}

interface NoteCountRow {
  item_type: string;
  gval: string;
  n: number;
}

interface TypeNoteRow {
  item_type: string;
  n: number;
}

/**
 * Nested warehouse view (db.py:957-1064): item type -> groups (by BOL# or
 * Building#, or by `item_name` for named types) with derived qty/status, plus
 * `other_values`, `vendors`, `flagged`, and note counts.
 */
export async function inventoryTree(
  db: SqlDatabase,
  groupBy = "bol",
  filters: InventoryFilters | null = null,
): Promise<InventoryTreeResult> {
  const gcol = GROUP_COLUMNS[groupBy] ?? "bol_number";
  const ocol = gcol === "bol_number" ? "building" : "bol_number";
  const named = NAMED_ITEM_TYPES;
  const namedIn = named.map(() => "?").join(",") || "''";
  const { clause, params } = filterWhere(filters);

  const rows = await db.all<TreeRow>(
    `SELECT item_type,
       CASE WHEN item_type IN (${namedIn}) THEN item_name ELSE ${gcol} END AS gval,
       CASE WHEN item_type IN (${namedIn}) THEN ${gcol} ELSE ${ocol} END AS oval,
       vendor,
       COALESCE(SUM(remaining), 0) AS in_wh,
       COALESCE(SUM(quantity), 0) AS capacity,
       COUNT(*) AS boxes,
       SUM(CASE WHEN flag <> '' THEN 1 ELSE 0 END) AS flagged,
       MIN(received_at) AS first_received,
       MAX(bol_doc_id) AS doc_id
FROM tags
${clause}
GROUP BY item_type, gval, oval, vendor
ORDER BY item_type, gval, oval`,
    [...named, ...named, ...params],
  );

  const noteRows = await db.all<NoteCountRow>(
    `SELECT item_type, ${gcol} AS gval, COUNT(*) AS n FROM notes GROUP BY item_type, gval`,
  );
  const typeNoteRows = await db.all<TypeNoteRow>(
    "SELECT item_type, COUNT(*) AS n FROM notes GROUP BY item_type",
  );

  const noteCounts = new Map<string, number>();
  for (const r of noteRows) noteCounts.set(`${r.item_type}\0${r.gval ?? ""}`, r.n);
  const typeNoteCounts = new Map<string, number>();
  for (const r of typeNoteRows) typeNoteCounts.set(r.item_type, r.n);

  const types = new Map<string, InternalType>();
  interface InternalGroup extends InventoryGroup {
    _others: Set<string>;
    _vendors: Set<string>;
  }
  interface InternalType {
    item_type: string;
    named: boolean;
    qty: number;
    groups: InternalGroup[];
  }
  const groups = new Map<string, InternalGroup>();

  for (const r of rows) {
    const isNamed = named.includes(r.item_type);
    let t = types.get(r.item_type);
    if (!t) {
      t = { item_type: r.item_type, named: isNamed, qty: 0, groups: [] };
      types.set(r.item_type, t);
    }
    const key = `${r.item_type}\0${r.gval ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        value: r.gval ?? "",
        in_wh: 0,
        capacity: 0,
        boxes: 0,
        flagged: 0,
        received_at: "",
        bol_doc_id: null,
        note_count: isNamed ? typeNoteCounts.get(r.item_type) ?? 0 : noteCounts.get(key) ?? 0,
        qty: 0,
        total: 0,
        received: "",
        status: "",
        other_values: [],
        vendors: [],
        _others: new Set<string>(),
        _vendors: new Set<string>(),
      };
      groups.set(key, g);
      t.groups.push(g);
    }
    g.in_wh += r.in_wh ?? 0;
    g.capacity += r.capacity ?? 0;
    g.boxes += r.boxes;
    g.flagged += r.flagged ?? 0;
    if (r.doc_id && !g.bol_doc_id) g.bol_doc_id = r.doc_id;
    const first = r.first_received ?? "";
    if (first && (!g.received_at || first < g.received_at)) g.received_at = first;
    if (r.oval) g._others.add(String(r.oval));
    if (r.vendor) g._vendors.add(String(r.vendor));
  }

  const resultTypes: InventoryType[] = [];
  for (const t of types.values()) {
    let typeQty = 0;
    const cleanGroups: InventoryGroup[] = t.groups.map((g) => {
      const qty = g.in_wh;
      typeQty += qty;
      const status =
        qty === 0 ? STATUS_DELIVERED : qty === g.capacity ? STATUS_IN : STATUS_PARTIAL;
      return {
        value: g.value,
        in_wh: g.in_wh,
        capacity: g.capacity,
        boxes: g.boxes,
        flagged: g.flagged,
        received_at: g.received_at,
        bol_doc_id: g.bol_doc_id,
        note_count: g.note_count,
        qty,
        total: g.capacity,
        received: dateOf(g.received_at),
        status,
        other_values: Array.from(g._others).sort(),
        vendors: Array.from(g._vendors).sort(),
      } satisfies InventoryGroup;
    });
    resultTypes.push({
      item_type: t.item_type,
      named: t.named,
      qty: typeQty,
      groups: cleanGroups,
    });
  }

  return { group_by: groupBy, types: resultTypes };
}

/** Tags within one (item_type, group) cell, for drill-down (db.py:1066-1083). */
export async function groupTags(
  db: SqlDatabase,
  itemType: string,
  groupBy: string,
  value: string,
  filters: InventoryFilters | null = null,
): Promise<GroupTagsResult> {
  const gcol = NAMED_ITEM_TYPES.includes(itemType)
    ? "item_name"
    : GROUP_COLUMNS[groupBy] ?? "bol_number";
  const { clause, params } = filterWhere(filters);
  const andClause = clause.replace(" WHERE ", " AND ");
  const rows = await db.all<TagRow>(
    `SELECT * FROM tags WHERE item_type=? AND ${gcol}=?${andClause} ORDER BY received_at, epc`,
    [itemType, value, ...params],
  );
  return { item_type: itemType, group_by: groupBy, value, tags: rows.map(tagDict) };
}

/** Flat per-box rows for CSV/PDF export (db.py:1085-1094). */
export async function exportRows(
  db: SqlDatabase,
  filters: InventoryFilters | null = null,
): Promise<Tag[]> {
  const { clause, params } = filterWhere(filters);
  const rows = await db.all<TagRow>(
    `SELECT * FROM tags${clause} ORDER BY item_type, bol_number, received_at, epc`,
    params,
  );
  return rows.map(tagDict);
}

/** Return a single tag dict (for the finder) or null (db.py:1096-1102). */
export async function findTag(db: SqlDatabase, epc: string): Promise<Tag | null> {
  const upper = epc.toUpperCase();
  const row = await db.get<TagRow>("SELECT * FROM tags WHERE epc=?", [upper]);
  return row ? tagDict(row) : null;
}

/** Distinct component names already used for a type (autocomplete, db.py:1104-1112). */
export async function itemNameSuggestions(db: SqlDatabase, itemType: string): Promise<string[]> {
  const rows = await db.all<{ item_name: string }>(
    "SELECT DISTINCT item_name FROM tags WHERE item_type=? AND item_name != '' ORDER BY item_name COLLATE NOCASE",
    [itemType],
  );
  return rows.map((r) => r.item_name);
}
