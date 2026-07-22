/**
 * Event-log repository: `logEvent` (db.py:298-304) and `listEvents`
 * (db.py:1117-1151).
 */

import { EVENT_FILTERS } from "../constants.js";
import type { SqlDatabase } from "../sql.js";
import type { EventRow } from "../types.js";
import { now } from "./util.js";

/** Append one audit row (db.py `_log`). */
export async function logEvent(
  db: SqlDatabase,
  action: string,
  epc = "",
  itemType = "",
  bolNumber = "",
  building = "",
  vendor = "",
  detail = "",
): Promise<void> {
  await db.run(
    "INSERT INTO events (ts, action, epc, item_type, bol_number, building, vendor, detail) " +
      "VALUES (?,?,?,?,?,?,?,?)",
    [now(), action, epc, itemType, bolNumber, building, vendor, detail],
  );
}

interface RawEventRow {
  id: number;
  ts: string;
  action: string;
  epc: string | null;
  item_type: string | null;
  bol_number: string | null;
  building: string | null;
  vendor: string | null;
  detail: string | null;
}

/** Audit-log read: events newest-first, optionally narrowed (db.py:1117-1151). */
export async function listEvents(
  db: SqlDatabase,
  filter = "all",
  epc?: string | null,
  limit = 500,
): Promise<EventRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const actions = filter ? EVENT_FILTERS[filter] : undefined;
  if (actions && actions.length > 0) {
    where.push(`action IN (${actions.map(() => "?").join(",")})`);
    params.push(...actions);
  }
  if (epc) {
    where.push("epc LIKE ?");
    params.push(`%${epc.toUpperCase()}%`);
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";

  let cap: number;
  if (typeof limit === "number" && Number.isFinite(limit)) {
    cap = Math.max(1, Math.min(Math.trunc(limit), 5000));
  } else {
    cap = 500;
  }
  params.push(cap);

  const rows = await db.all<RawEventRow>(
    "SELECT id, ts, action, epc, item_type, bol_number, building, vendor, detail " +
      "FROM events" +
      clause +
      " ORDER BY id DESC LIMIT ?",
    params,
  );
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
