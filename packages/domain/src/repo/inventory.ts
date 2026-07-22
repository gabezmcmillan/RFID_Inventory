/**
 * Inventory repository: sweeps, the interactive warehouse view, drill-down,
 * export, and the finder (db.py:859-1112).
 *
 * Dynamic identifiers (`group_by`) are mapped through the typed
 * `GROUP_COLUMNS` whitelist and never reach SQL from a caller string. The
 * `inventoryTree` aggregation (CASE over the named-type set, GROUP BY over
 * computed columns, joined note counts) fights the query builder, so it uses
 * Drizzle's `sql` template operator with typed result mapping — the preferred
 * shape for complex aggregates.
 */

import { and, asc, eq, inArray, like, ne, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import {
  GROUP_COLUMNS,
  NAMED_ITEM_TYPES,
  STATUS_DELIVERED,
  STATUS_IN,
  STATUS_PARTIAL,
} from "../constants.js";
import type { DomainDb } from "../db.js";
import { withTransaction } from "../db.js";
import { notes, tags } from "../schema.js";
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

/** Map a whitelisted group column name to its Drizzle column on `tags`. */
const GROUP_COLUMN: Record<string, AnySQLiteColumn> = {
  bol_number: tags.bol_number,
  building: tags.building,
  item_name: tags.item_name,
};

/** Shared warehouse-filter WHERE builder (db.py:926-955), as a Drizzle SQL fragment. */
function filterWhere(filters: InventoryFilters | null | undefined): SQL | undefined {
  const f = filters ?? {};
  const conds: SQL[] = [];
  if (f.bol) conds.push(like(tags.bol_number, `%${f.bol}%`));
  if (f.building) conds.push(eq(tags.building, String(f.building)));
  if (f.received_from) conds.push(sql`substr(${tags.received_at}, 1, 10) >= ${f.received_from}`);
  if (f.received_to) conds.push(sql`substr(${tags.received_at}, 1, 10) <= ${f.received_to}`);
  if (f.checked_out_from) {
    conds.push(sql`${tags.delivered_at} != '' AND substr(${tags.delivered_at}, 1, 10) >= ${f.checked_out_from}`);
  }
  if (f.checked_out_to) {
    conds.push(sql`${tags.delivered_at} != '' AND substr(${tags.delivered_at}, 1, 10) <= ${f.checked_out_to}`);
  }
  return and(...conds);
}

/** Inventory sweep (db.py:859-901). Read-only for quantities; logs `COUNT` per tag. */
export async function recordInventory(
  db: DomainDb,
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
      const rows = await db.select().from(tags).where(eq(tags.epc, epc));
      const row = rows[0];
      if (!row) {
        unknown.push(epc);
        await logEvent(db, "COUNT", epc, "UNKNOWN");
        continue;
      }
      items.push(tagDict(row));
      if (row.remaining <= 0) {
        const flag = `Checked out ${dateOf(row.delivered_at)}; detected in sweep`;
        await db
          .update(tags)
          .set({ flag, flagged_at: ts, updated_at: ts })
          .where(eq(tags.epc, epc));
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
  db: DomainDb,
  epcs: string[],
): Promise<CompareInventoryResult> {
  const scanned = new Set(epcs.map((e) => e.toUpperCase()));
  const rows = await db
    .select()
    .from(tags)
    .where(sql`${tags.remaining} > 0`)
    .orderBy(asc(tags.item_type), asc(tags.bol_number), asc(tags.epc));
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
 *
 * The CASE-over-named-types + GROUP-BY-computed-columns shape fights the query
 * builder, so this uses the `sql` template operator with typed result mapping.
 * Column names (`gcol`/`ocol`) come from the `GROUP_COLUMNS` whitelist and are
 * injected as raw identifiers; the named-type set and filter values are bound
 * parameters.
 */
export async function inventoryTree(
  db: DomainDb,
  groupBy = "bol",
  filters: InventoryFilters | null = null,
): Promise<InventoryTreeResult> {
  const gcol = GROUP_COLUMNS[groupBy] ?? "bol_number";
  const ocol = gcol === "bol_number" ? "building" : "bol_number";
  const named = NAMED_ITEM_TYPES;
  const namedIn = inArray(tags.item_type, named);
  const where = filterWhere(filters);

  const rows = await db.all<TreeRow>(sql`
    SELECT item_type,
       CASE WHEN ${namedIn} THEN ${tags.item_name} ELSE ${sql.raw(gcol)} END AS gval,
       CASE WHEN ${namedIn} THEN ${sql.raw(gcol)} ELSE ${sql.raw(ocol)} END AS oval,
       vendor,
       COALESCE(SUM(remaining), 0) AS in_wh,
       COALESCE(SUM(quantity), 0) AS capacity,
       COUNT(*) AS boxes,
       SUM(CASE WHEN flag <> '' THEN 1 ELSE 0 END) AS flagged,
       MIN(received_at) AS first_received,
       MAX(bol_doc_id) AS doc_id
    FROM tags
    ${where ? sql`WHERE ${where}` : sql``}
    GROUP BY item_type, gval, oval, vendor
    ORDER BY item_type, gval, oval
  `);

  const noteRows = await db.all<NoteCountRow>(sql`
    SELECT item_type, ${sql.raw(gcol)} AS gval, COUNT(*) AS n
    FROM notes GROUP BY item_type, gval
  `);
  const typeNoteRows = await db.all<TypeNoteRow>(sql`
    SELECT item_type, COUNT(*) AS n FROM notes GROUP BY item_type
  `);

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
  db: DomainDb,
  itemType: string,
  groupBy: string,
  value: string,
  filters: InventoryFilters | null = null,
): Promise<GroupTagsResult> {
  const gcol = NAMED_ITEM_TYPES.includes(itemType)
    ? "item_name"
    : GROUP_COLUMNS[groupBy] ?? "bol_number";
  const where = and(eq(tags.item_type, itemType), eq(GROUP_COLUMN[gcol] ?? tags.bol_number, value), filterWhere(filters));
  const rows = await db
    .select()
    .from(tags)
    .where(where)
    .orderBy(asc(tags.received_at), asc(tags.epc));
  return { item_type: itemType, group_by: groupBy, value, tags: rows.map(tagDict) };
}

/** Flat per-box rows for CSV/PDF export (db.py:1085-1094). */
export async function exportRows(
  db: DomainDb,
  filters: InventoryFilters | null = null,
): Promise<Tag[]> {
  const where = filterWhere(filters);
  const rows = await db
    .select()
    .from(tags)
    .where(where)
    .orderBy(asc(tags.item_type), asc(tags.bol_number), asc(tags.received_at), asc(tags.epc));
  return rows.map(tagDict);
}

/** Return a single tag dict (for the finder) or null (db.py:1096-1102). */
export async function findTag(db: DomainDb, epc: string): Promise<Tag | null> {
  const upper = epc.toUpperCase();
  const rows = await db.select().from(tags).where(eq(tags.epc, upper));
  return rows[0] ? tagDict(rows[0]) : null;
}

/** Distinct component names already used for a type (autocomplete, db.py:1104-1112). */
export async function itemNameSuggestions(db: DomainDb, itemType: string): Promise<string[]> {
  const rows = await db
    .select({ item_name: tags.item_name })
    .from(tags)
    .where(and(eq(tags.item_type, itemType), ne(tags.item_name, "")))
    .orderBy(sql`${tags.item_name} COLLATE NOCASE`);
  return rows.map((r) => r.item_name);
}
