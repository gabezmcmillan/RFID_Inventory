/**
 * Shared repository helpers, ported from `apps/warehouse/db.py` (the `_now`,
 * `_today`, `_date_of`, `_as_quantity`, `_tag_dict` internals).
 *
 * Timestamps are local ISO seconds (no timezone suffix), matching Python's
 * `datetime.now().isoformat(timespec="seconds")`.
 */

import { and, eq, sql } from "drizzle-orm";

import type { DomainDb } from "../db";
import { localMeta, tags } from "../schema";
import type { Tag, TagRow } from "../types";

/** Local now as ISO seconds, e.g. "2026-07-22T11:09:00" (db.py:66-67). */
export function now(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Today as MM/DD/YYYY (db.py:70-71). */
export function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
}

/** Format an ISO timestamp as MM/DD/YYYY for display (best effort, db.py:74-79). */
export function dateOf(isoTs: string | null | undefined): string {
  if (!isoTs) return "";
  const d = new Date(isoTs);
  if (Number.isNaN(d.getTime())) return isoTs;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
}

/**
 * Coerce a user-supplied value to a positive int (>= 1) by default
 * (db.py:57-63). Pass `default=0` for the remaining-edit path, which wants
 * 0 for blank/invalid/negative input.
 */
export function asQuantity(value: unknown, def = 1): number {
  if (value === null || value === undefined) return def;
  const s = String(value).trim();
  if (s === "") return def;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  return i >= 1 ? i : def;
}

/** Public tag dict (Python `_tag_dict`, db.py:316-337). */
export function tagDict(row: TagRow): Tag {
  return {
    epc: row.epc,
    item_type: row.item_type,
    item_name: row.item_name,
    bol_number: row.bol_number,
    po_number: row.po_number,
    bol_doc_id: row.bol_doc_id,
    building: row.building,
    sector: row.sector,
    vendor: row.vendor,
    sku: row.sku,
    mfc_date: row.mfc_date,
    quantity: row.quantity,
    remaining: row.remaining,
    status: row.status,
    received_at: row.received_at,
    delivered_at: row.delivered_at,
    checkout_building: row.checkout_building,
    flag: row.flag,
    flagged_at: row.flagged_at,
  };
}

/** Units (not boxes) still in the warehouse for a group: SUM(remaining) (db.py:306-313). */
export async function groupInWarehouseQty(
  db: DomainDb,
  itemType: string,
  bolNumber: string,
  building: string,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COALESCE(SUM(${tags.remaining}), 0)` })
    .from(tags)
    .where(and(eq(tags.item_type, itemType), eq(tags.bol_number, bolNumber), eq(tags.building, building)));
  return rows[0]?.n ?? 0;
}

/** Read a `local_meta` value (undefined if absent). */
export async function getMeta(db: DomainDb, key: string): Promise<string | undefined> {
  const rows = await db
    .select({ value: localMeta.value })
    .from(localMeta)
    .where(eq(localMeta.key, key));
  return rows[0]?.value;
}

/** Upsert a `local_meta` value. */
export async function setMeta(db: DomainDb, key: string, value: string): Promise<void> {
  await db
    .insert(localMeta)
    .values({ key, value })
    .onConflictDoUpdate({ target: localMeta.key, set: { value } });
}
