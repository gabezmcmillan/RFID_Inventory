/** Web jobsite repository (ports apps/cloud/db.py:436-748): stock browse + cart
 * view, order status, header counts, and the all-or-nothing cart submission.
 * The web app is a thin rendering layer over these; the substance lives here so
 * it is Node-tested like every other repo.
 *
 * Conventions ported from the Python reference:
 *  - Web-created request rows stamp created_at in UTC with an explicit +00:00
 *    offset (db.py:131-137) so every viewer converts to its own zone; the
 *    warehouse device keeps using local now().
 *  - Quantity parsing is strict (db.py:140-147): a non-integer or < 1 value is
 *    rejected, never clamped.
 *  - createCartRequest is all-or-nothing: per-line shape checks, then per
 *    stock-row aggregate checks so two lines drawing on the same
 *    (type, item_name, stock building) cannot jointly exceed availability.
 *
 * No un-aliased builder joins: every aggregate uses the sql template operator
 * with named result columns (the established pattern in repo/inventory.ts), so
 * the field app RN array-mode adapter is safe. */

import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";

import { REQUEST_PENDING, REQUEST_STAGING } from "../constants";
import type { DomainDb } from "../db";
import { withTransaction } from "../db";
import { requests, tags } from "../schema";
import type { MaterialRequest } from "../types";
import { listRequests } from "./requests";

/** One BOL breakdown row in a plain-type stock row drill-down. */
export interface StockGroup {
  bol_number: string;
  vendor: string;
  units: number;
  boxes: number;
  first_received: string;
}

/** One component (name x building) in a named-type stock row drill-down. */
export interface StockComponent {
  item_name: string;
  building: string;
  units: number;
  capacity: number;
  boxes: number;
  bol_numbers: string[];
  vendors: string[];
  first_received: string;
  status: string;
}

/** A requestable stock row (db.py:436-527): plain type per building, or one row per named type. */
export interface StockRow {
  item_type: string;
  item_name: string;
  named: boolean;
  building: string;
  buildings: string[];
  units: number;
  boxes: number;
  vendors: string[];
  oldest_received: string;
  groups: StockGroup[];
  components: StockComponent[];
}

/** Header numbers (db.py:539-551): warehouse units + open request count. */
export interface Counts {
  units: number;
  requests_pending: number;
}

/** One cart line submitted by the jobsite user. building is the stock row building. */
export interface CartLineInput {
  item_type: string;
  item_name?: string;
  building?: string;
  quantity?: unknown;
  delivery_building?: string;
}

/** Per-line validation error; line is the index into the submitted cart. */
export interface CartLineError {
  line: number;
  message: string;
}

/** Success shape of createCartRequest (db.py:695-711). */
export interface CartOkResult {
  ok: true;
  order_ref: string;
  ids: number[];
  message: string;
}

/** Failure shape of createCartRequest (db.py:643-693). */
export interface CartErrResult {
  ok: false;
  message: string;
  errors: CartLineError[];
}

export type CreateCartRequestResult = CartOkResult | CartErrResult;

/** One order (a group of request rows sharing an order_ref) for the status page. */
export interface Order {
  order_ref: string;
  lines: MaterialRequest[];
  requester: string;
  contact: string;
  jobsite: string;
  building: string;
  created_at: string;
  open: boolean;
  max_id: number;
}

/** UTC now as ISO seconds with an explicit +00:00 offset
 * (e.g. 2026-07-22T18:00:00+00:00), matching apps/cloud/db.py:131-137 so each
 * viewer new Date(...) converts to its own zone. The warehouse device keeps
 * using local now(). Uses no node:crypto so it is React-Native-safe. */
export function nowUtc(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  return y + "-" + mo + "-" + da + "T" + h + ":" + mi + ":" + s + "+00:00";
}

/** Strict positive-int parse (db.py:140-147). null means invalid: callers
 * reject, never clamp. A non-integer string ("2.5") or any value < 1 is
 * rejected, matching Python int(str(value).strip()) (which raises on "2.5"). */
export function parseStrictQuantity(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) return null;
  return n >= 1 ? n : null;
}

/** Short, human-readable order id shared by the lines of one cart
 * (db.py:150-152): 6 uppercase hex chars. Uses Web Crypto so it is RN-safe. */
export function newOrderRef(): string {
  const bytes = new Uint8Array(3);
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.getRandomValues !== "function") {
    throw new Error("Web Crypto getRandomValues is unavailable");
  }
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

interface StockRawRow {
  item_type: string;
  item_name: string;
  building: string;
  bol_number: string;
  vendor: string;
  units: number;
  capacity: number;
  boxes: number;
  first_received: string | null;
}

/**
 * Requestable stock for the cart view (db.py:436-527). Only stock with
 * remaining > 0 appears. Plain types: one row per item type x building (units
 * summed across BOLs) with a BOL breakdown. Named types (any type whose in-stock
 * boxes carry item_name, e.g. W.I.F.): ONE row for the whole type whose
 * drill-down is components (one entry per component name x building with
 * units/capacity/boxes/BOLs/first-received/status), and the component is what
 * gets requested. Status is "In Warehouse" when units == capacity else "Partial".
 */
export async function stockRows(db: DomainDb): Promise<StockRow[]> {
  const rows = await db.all<StockRawRow>(sql`
    SELECT item_type,
           COALESCE(item_name, '')  AS item_name,
           COALESCE(building, '')   AS building,
           bol_number,
           vendor,
           COALESCE(SUM(remaining), 0) AS units,
           COALESCE(SUM(quantity), 0)  AS capacity,
           COUNT(*)                    AS boxes,
           MIN(received_at)            AS first_received
    FROM tags
    WHERE COALESCE(remaining, 0) > 0
    GROUP BY item_type, COALESCE(item_name, ''),
             COALESCE(building, ''), bol_number, vendor
    ORDER BY item_type, COALESCE(item_name, ''),
             COALESCE(building, ''), bol_number
  `);

  const namedTypes = new Set(rows.filter((r) => r.item_name).map((r) => r.item_type));
  const stock = new Map<string, StockRow>();
  const components = new Map<string, StockComponent>();

  for (const r of rows) {
    const named = namedTypes.has(r.item_type);
    const key = named ? r.item_type : r.item_type + "\0" + r.building;
    let row = stock.get(key);
    if (!row) {
      row = {
        item_type: r.item_type,
        item_name: "",
        named,
        building: named ? "" : r.building,
        buildings: [],
        units: 0,
        boxes: 0,
        vendors: [],
        oldest_received: "",
        groups: [],
        components: [],
      };
      stock.set(key, row);
    }
    row.units += r.units;
    row.boxes += r.boxes;
    if (r.vendor && !row.vendors.includes(r.vendor)) row.vendors.push(r.vendor);
    if (r.building && !row.buildings.includes(r.building)) row.buildings.push(r.building);
    const first = r.first_received ?? "";
    if (first && (!row.oldest_received || first < row.oldest_received)) {
      row.oldest_received = first;
    }
    if (!named) {
      row.groups.push({
        bol_number: r.bol_number,
        vendor: r.vendor,
        units: r.units,
        boxes: r.boxes,
        first_received: r.first_received ?? "",
      });
      continue;
    }
    const ckey = r.item_type + "\0" + r.item_name + "\0" + r.building;
    let comp = components.get(ckey);
    if (!comp) {
      comp = {
        item_name: r.item_name,
        building: r.building,
        units: 0,
        capacity: 0,
        boxes: 0,
        bol_numbers: [],
        vendors: [],
        first_received: "",
        status: "",
      };
      components.set(ckey, comp);
      row.components.push(comp);
    }
    comp.units += r.units;
    comp.capacity += r.capacity;
    comp.boxes += r.boxes;
    if (r.bol_number && !comp.bol_numbers.includes(r.bol_number)) comp.bol_numbers.push(r.bol_number);
    if (r.vendor && !comp.vendors.includes(r.vendor)) comp.vendors.push(r.vendor);
    if (first && (!comp.first_received || first < comp.first_received)) comp.first_received = first;
  }

  for (const comp of components.values()) {
    comp.status = comp.units === comp.capacity ? "In Warehouse" : "Partial";
  }
  return Array.from(stock.values());
}

/** Known delivery buildings: every building the warehouse has ever seen (db.py:529-537). */
export async function buildings(db: DomainDb): Promise<string[]> {
  const rows = await db
    .select({ b: tags.building })
    .from(tags)
    .where(ne(tags.building, ""))
    .orderBy(asc(tags.building));
  return Array.from(new Set(rows.map((r) => r.b)));
}

/** Header numbers (db.py:539-551): total warehouse units + open request count. */
export async function counts(db: DomainDb): Promise<Counts> {
  const unitRows = await db
    .select({ units: sql<number>`COALESCE(SUM(${tags.remaining}), 0)` })
    .from(tags);
  const pendingRows = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(requests)
    .where(inArray(requests.status, [REQUEST_PENDING, REQUEST_STAGING]));
  return { units: unitRows[0]?.units ?? 0, requests_pending: pendingRows[0]?.n ?? 0 };
}

/**
 * Last-updated timestamp for the site header: the max `tags.updated_at` across
 * all boxes (the mirror's "last synced" concept no longer exists; the warehouse
 * device stamps `updated_at` on every change). "" when there are no tags yet.
 */
export async function lastUpdated(db: DomainDb): Promise<string> {
  const rows = await db
    .select({ max: sql<string>`MAX(${tags.updated_at})` })
    .from(tags);
  return rows[0]?.max ?? "";
}

/**
 * Units on hand for an item type + component name ('' for types without
 * component names), optionally scoped to the building the stock is assigned to
 * ('' = unassigned). Runs on the caller db so checks and inserts share one
 * transaction (db.py:554-569).
 */
async function availableUnits(
  db: DomainDb,
  itemType: string,
  itemName: string,
  stockBuilding: string | null,
): Promise<number> {
  const conds = [
    eq(tags.item_type, itemType),
    eq(tags.item_name, itemName),
    sql`${tags.remaining} > 0`,
  ];
  if (stockBuilding !== null) conds.push(eq(tags.building, stockBuilding));
  const rows = await db
    .select({ n: sql<number>`COALESCE(SUM(${tags.remaining}), 0)` })
    .from(tags)
    .where(and(...conds));
  return rows[0]?.n ?? 0;
}

/**
 * One requested line against the mirrored stock (db.py:571-590). Returns an
 * error message, or null when the line is fulfillable as asked.
 */
async function validateLine(
  db: DomainDb,
  itemType: string,
  quantity: number,
  itemName: string,
  stockBuilding: string | null,
): Promise<string | null> {
  if (!itemType) return "An item type is required.";
  const available = await availableUnits(db, itemType, itemName, stockBuilding);
  const label = itemName ? itemType + " | " + itemName : itemType;
  const where = stockBuilding ? " in Building " + stockBuilding : "";
  if (available <= 0) return "No " + label + " in stock" + where + " right now.";
  if (quantity > available) {
    return "Only " + available + " unit(s) of " + label + " available" + where + "; requested " + quantity + ".";
  }
  return null;
}

/**
 * One submitted cart -> N request rows sharing an order_ref, in a single
 * all-or-nothing transaction (db.py:623-712). Per-line checks (item type
 * present, quantity valid, delivery building required), then aggregate checks
 * so two lines drawing on the same (type, item_name, stock building) cannot
 * jointly exceed availability. Each line's delivery_building is stored on its
 * row; the order-level delivery_building is a legacy fallback for lines that
 * don't carry their own. Returns {ok, order_ref, ids, message} or
 * {ok: false, message, errors: [{line, message}]}.
 */
export async function createCartRequest(
  db: DomainDb,
  requester: string,
  contact: string,
  jobsite: string,
  note: string,
  deliveryBuilding: string,
  lines: CartLineInput[],
): Promise<CreateCartRequestResult> {
  const cleanRequester = (requester ?? "").toString().trim();
  const cleanDelivery = (deliveryBuilding ?? "").toString().trim();
  const cleanJobsite = (jobsite ?? "").toString().trim();
  const cleanContact = (contact ?? "").toString().trim();
  const cleanNote = (note ?? "").toString().trim();
  const cleanLines = lines ?? [];

  if (!cleanRequester) {
    return { ok: false, message: "Your name is required.", errors: [] };
  }
  if (cleanLines.length === 0) {
    return { ok: false, message: "The cart is empty.", errors: [] };
  }

  return withTransaction(db, async () => {
    const errors: CartLineError[] = [];
    const parsed: Array<{
      i: number;
      itemType: string;
      itemName: string;
      stockBuilding: string;
      qty: number;
      deliverTo: string;
    }> = [];

    for (const [i, line] of cleanLines.entries()) {
      const itemType = (line.item_type ?? "").toString().trim();
      const itemName = (line.item_name ?? "").toString().trim();
      const stockBuilding = (line.building ?? "").toString().trim();
      const deliverTo = ((line.delivery_building ?? "").toString().trim()) || cleanDelivery;
      const qty = parseStrictQuantity(line.quantity);
      if (!itemType) {
        errors.push({ line: i, message: "An item type is required." });
      } else if (qty === null) {
        errors.push({ line: i, message: "Quantity must be a whole number of 1 or more." });
      } else if (!deliverTo) {
        errors.push({ line: i, message: "A delivery building is required for this item." });
      } else {
        parsed.push({ i, itemType, itemName, stockBuilding, qty, deliverTo });
      }
    }

    interface Group {
      itemType: string;
      itemName: string;
      stockBuilding: string;
      total: number;
      lines: number[];
    }
    const groups = new Map<string, Group>();
    for (const p of parsed) {
      const gkey = p.itemType + "\0" + p.itemName + "\0" + p.stockBuilding;
      let g = groups.get(gkey);
      if (!g) {
        g = { itemType: p.itemType, itemName: p.itemName, stockBuilding: p.stockBuilding, total: 0, lines: [] };
        groups.set(gkey, g);
      }
      g.total += p.qty;
      g.lines.push(p.i);
    }
    for (const g of groups.values()) {
      const message = await validateLine(db, g.itemType, g.total, g.itemName, g.stockBuilding);
      if (message) {
        for (const i of g.lines) errors.push({ line: i, message });
      }
    }

    if (errors.length > 0) {
      errors.sort((a, b) => a.line - b.line);
      return {
        ok: false,
        errors,
        message: "Some items can't be fulfilled as requested.",
      } satisfies CartErrResult;
    }

    const orderRef = newOrderRef();
    const ts = nowUtc();
    const ids: number[] = [];
    for (const p of parsed) {
      const inserted = await db
        .insert(requests)
        .values({
          item_type: p.itemType,
          item_name: p.itemName,
          quantity: p.qty,
          building: p.deliverTo,
          jobsite: cleanJobsite,
          requester: cleanRequester,
          contact: cleanContact,
          note: cleanNote,
          status: REQUEST_PENDING,
          created_at: ts,
          handled_at: "",
          handler_note: "",
          order_ref: orderRef,
          updated_at: ts,
        })
        .returning({ id: requests.id });
      ids.push(inserted[0]?.id ?? 0);
    }
    const noun = ids.length === 1 ? "item" : "items";
    return {
      ok: true,
      order_ref: orderRef,
      ids,
      message: "Order " + orderRef + " submitted (" + ids.length + " " + noun + ").",
    } satisfies CartOkResult;
  });
}

/**
 * Requests grouped into orders for the status page (db.py:723-748). Lines
 * sharing an order_ref group together; legacy rows (no ref) stand alone. Open
 * orders (any line pending/staging) first, then newest. The order-header
 * building is shown only when every line agrees (lines show their own
 * otherwise).
 */
export async function listOrders(db: DomainDb, limit = 100): Promise<Order[]> {
  const rows = await listRequests(db, null);
  const capped = rows.slice(0, limit);
  const orders = new Map<string, Order>();
  for (const r of capped) {
    const key = r.order_ref || "request-" + r.id;
    let o = orders.get(key);
    if (!o) {
      o = {
        order_ref: r.order_ref,
        lines: [],
        requester: r.requester,
        contact: r.contact,
        jobsite: r.jobsite,
        building: r.building,
        created_at: r.created_at,
        open: false,
        max_id: 0,
      };
      orders.set(key, o);
    }
    o.lines.push(r);
    if (r.status === REQUEST_PENDING || r.status === REQUEST_STAGING) o.open = true;
    if (r.id > o.max_id) o.max_id = r.id;
  }
  const result = Array.from(orders.values());
  for (const o of result) {
    o.lines.sort((a, b) => a.id - b.id);
    const buildings = new Set(o.lines.map((r) => r.building));
    o.building = buildings.size === 1 ? o.lines[0]?.building ?? "" : "";
  }
  result.sort((a, b) => Number(a.open === false) - Number(b.open === false) || b.max_id - a.max_id);
  return result;
}
