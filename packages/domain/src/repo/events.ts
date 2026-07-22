/**
 * Event-log repository: `logEvent` (db.py:298-304) and `listEvents`
 * (db.py:1117-1151).
 */

import { and, desc, inArray, like } from "drizzle-orm";

import { EVENT_FILTERS } from "../constants.js";
import type { DomainDb } from "../db.js";
import { events } from "../schema.js";
import type { EventRow } from "../types.js";
import { now } from "./util.js";

/** Append one audit row (db.py `_log`). */
export async function logEvent(
  db: DomainDb,
  action: string,
  epc = "",
  itemType = "",
  bolNumber = "",
  building = "",
  vendor = "",
  detail = "",
): Promise<void> {
  await db.insert(events).values({
    ts: now(),
    action,
    epc,
    item_type: itemType,
    bol_number: bolNumber,
    building,
    vendor,
    detail,
  });
}

/** Audit-log read: events newest-first, optionally narrowed (db.py:1117-1151). */
export async function listEvents(
  db: DomainDb,
  filter = "all",
  epc?: string | null,
  limit = 500,
): Promise<EventRow[]> {
  const actions = filter ? EVENT_FILTERS[filter] : undefined;

  let cap: number;
  if (typeof limit === "number" && Number.isFinite(limit)) {
    cap = Math.max(1, Math.min(Math.trunc(limit), 5000));
  } else {
    cap = 500;
  }

  const where = and(
    actions && actions.length > 0 ? inArray(events.action, actions) : undefined,
    epc ? like(events.epc, `%${epc.toUpperCase()}%`) : undefined,
  );

  const rows = await db
    .select({
      id: events.id,
      ts: events.ts,
      action: events.action,
      epc: events.epc,
      item_type: events.item_type,
      bol_number: events.bol_number,
      building: events.building,
      vendor: events.vendor,
      detail: events.detail,
    })
    .from(events)
    .where(where)
    .orderBy(desc(events.id))
    .limit(cap);

  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    action: r.action,
    epc: r.epc ?? "",
    item_type: r.item_type ?? "",
    bol_number: r.bol_number ?? "",
    building: r.building ?? "",
    vendor: r.vendor ?? "",
    detail: r.detail ?? "",
  }));
}
