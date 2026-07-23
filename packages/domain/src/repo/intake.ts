/**
 * Intake repository: `receiveShipment` (db.py:371-434), `amendCheckin`
 * (db.py:436-486), and `allocateEpcs` (db.py:342-369) with the new
 * multi-device EPC layout (plan 002 standing decision).
 */

import { eq, inArray } from "drizzle-orm";

import {
  EPC_DEVICE_LEN,
  EPC_SERIAL_LEN,
  PRINTER_EPC_PREFIX,
  STATUS_IN,
} from "../constants";
import type { DomainDb } from "../db";
import { withTransaction } from "../db";
import { newId } from "../id";
import { tags } from "../schema";
import type { AmendCheckinResult, ReceiveShipmentResult, Tag, TagRow } from "../types";
import { logEvent } from "./events";
import {
  asQuantity,
  groupInWarehouseQty,
  now,
  tagDict,
} from "./util";

/** Per-unit item fields accepted at check-in. */
export interface ItemFields {
  item_name?: string | null;
  sku?: string | null;
  mfc_date?: string | null;
  quantity?: unknown;
}

/**
 * Source of this device's permanent 2-hex id and its monotonic EPC serial
 * counter (plan 010 Phase 2). The serial counter lives in a **separate
 * local-only device database** (NOT the synced domain DB) so two replicas
 * never share a serial sequence. `reserveSerials` is atomic: it advances the
 * counter by `count` and returns the FIRST serial of the reserved range
 * `[first, first + count - 1]`. The counter only ever moves forward, so a
 * crash after reservation but before the labels print wastes those serials but
 * never reuses them.
 */
export interface EpcSerialAllocator {
  /** The permanently-assigned 2-hex device id for this device (any case; normalized to 2 uppercase hex). */
  deviceId(): Promise<string>;
  /**
   * Atomically reserve `count` sequential serials; return the first. The
   * counter advances by `count` and never decreases.
   */
  reserveSerials(count: number): Promise<number>;
}

/**
 * Pure in-memory {@link EpcSerialAllocator} for tests and non-RN environments.
 * Not for production: the counter is process-local and not persisted. Honors
 * the same atomic, never-reuse contract as the on-device implementation.
 */
export function makeInMemoryEpcAllocator(deviceId: string, startSerial = 0): EpcSerialAllocator {
  let counter = startSerial;
  return {
    deviceId: async () => deviceId,
    reserveSerials: async (count: number) => {
      const n = Math.max(1, Math.trunc(count) || 1);
      counter += n;
      return counter - n + 1;
    },
  };
}

function normalizeDeviceId(value: string): string {
  const hex = value.toUpperCase().padStart(EPC_DEVICE_LEN, "0");
  return hex.slice(0, EPC_DEVICE_LEN);
}

/**
 * Mint unique EPCs for printer-encoded labels (db.py:342-369).
 *
 * Layout: `EPC = PRINTER_EPC_PREFIX (8 hex) + device id (2 hex) + per-device
 * serial (14 hex)`. The serial is reserved atomically from the injected
 * {@link EpcSerialAllocator} (a local-only device DB on-device), so two
 * replicas never share a serial and a crash after reservation wastes serials
 * but never reuses them. Reserved serials that already exist in `tags` (a
 * restore-from-backup edge case) are skipped and replaced by freshly reserved
 * serials — the counter only advances, so no serial is ever reused.
 */
export async function allocateEpcs(
  db: DomainDb,
  count = 1,
  allocator: EpcSerialAllocator,
): Promise<string[]> {
  const prefix = PRINTER_EPC_PREFIX.toUpperCase();
  const dev = normalizeDeviceId(await allocator.deviceId());
  const want = Math.max(1, Math.trunc(count) || 1);

  const epcs: string[] = [];
  let first = await allocator.reserveSerials(want);
  while (epcs.length < want) {
    const remaining = want - epcs.length;
    const candidates: string[] = [];
    for (let i = 0; i < remaining; i++) {
      const serial = first + i;
      candidates.push(prefix + dev + serial.toString(16).toUpperCase().padStart(EPC_SERIAL_LEN, "0"));
    }
    const existing = await db
      .select({ epc: tags.epc })
      .from(tags)
      .where(inArray(tags.epc, candidates));
    const taken = new Set(existing.map((r) => r.epc));
    let collisions = 0;
    for (const epc of candidates) {
      if (taken.has(epc)) {
        collisions += 1;
      } else {
        epcs.push(epc);
      }
    }
    if (collisions > 0) {
      // Replace the colliding serials with a freshly reserved range (counter
      // advances; never reuses).
      first = await allocator.reserveSerials(collisions);
    }
  }
  return epcs;
}

/**
 * Check In: record a shipment's tags and report the group's quantity
 * (db.py:371-434). EPCs are deduped uppercase; already-on-file EPCs are
 * reported in `duplicates` and not re-inserted. Each inserted tag carries
 * quantity = remaining = units and logs an `IN` event with the same detail.
 */
export async function receiveShipment(
  db: DomainDb,
  epcs: string[],
  itemType: string,
  building: string,
  bolNumber: string,
  vendor: string,
  itemFields: ItemFields = {},
  bolDocId: string | null = null,
  poNumber = "",
  sector = "",
): Promise<ReceiveShipmentResult> {
  const itemName = (itemFields.item_name ?? "").toString().trim();
  const sku = (itemFields.sku ?? "").toString().trim();
  const mfcDate = (itemFields.mfc_date ?? "").toString().trim();
  const units = asQuantity(itemFields.quantity);
  const ts = now();

  const ordered = Array.from(new Set(epcs.map((e) => e.toUpperCase())));
  const duplicates: string[] = [];
  const addedEpcs: string[] = [];
  let added = 0;
  let addedUnits = 0;

  await withTransaction(db, async () => {
    const existing = new Set<string>();
    for (const epc of ordered) {
      const rows = await db.select({ epc: tags.epc }).from(tags).where(eq(tags.epc, epc));
      if (rows.length > 0) existing.add(epc);
    }

    for (const epc of ordered) {
      if (existing.has(epc)) {
        duplicates.push(epc);
        continue;
      }
      await db.insert(tags).values({
        id: newId(),
        epc,
        item_type: itemType,
        item_name: itemName,
        bol_number: bolNumber,
        po_number: poNumber,
        bol_doc_id: bolDocId,
        building,
        sector,
        vendor,
        sku,
        mfc_date: mfcDate,
        quantity: units,
        remaining: units,
        status: STATUS_IN,
        received_at: ts,
        delivered_at: "",
        created_at: ts,
        updated_at: ts,
      });
      let detail = `qty ${units}`;
      if (itemName) detail += `, name ${itemName}`;
      if (poNumber) detail += `, PO ${poNumber}`;
      await logEvent(db, "IN", epc, itemType, bolNumber, building, vendor, detail);
      added += 1;
      addedUnits += units;
      addedEpcs.push(epc);
    }
  });

  const qty = await groupInWarehouseQty(db, itemType, bolNumber, building);

  const boxWord = added === 1 ? "box" : "boxes";
  let msg = `Received ${added} ${boxWord} (${addedUnits} units) of ${itemType} (BOL ${bolNumber || "n/a"}, ${building || "n/a"}).`;
  if (duplicates.length > 0) msg += ` ${duplicates.length} already on file.`;

  return {
    ok: true,
    message: msg,
    added,
    added_units: addedUnits,
    quantity: units,
    duplicates,
    epcs: addedEpcs,
    epc: addedEpcs[0] ?? "",
    qty,
    item_type: itemType,
    item_name: itemName,
    bol_number: bolNumber,
    po_number: poNumber,
    bol_doc_id: bolDocId,
    building,
    sector,
    vendor,
    sku,
    mfc_date: mfcDate,
  };
}

/**
 * Operator correction of a just-checked-in box (db.py:436-486).
 *
 * Only `item_name` / `sku` / `mfc_date` / `quantity` are editable; a quantity
 * edit also resets `remaining` (nothing has been drawn from a just-received
 * box). Logs an `EDIT` event with `"check-in fix: field: 'old' -> 'new'"`.
 */
export async function amendCheckin(
  db: DomainDb,
  epc: string,
  fields: { item_name?: string | null; sku?: string | null; mfc_date?: string | null; quantity?: unknown },
): Promise<AmendCheckinResult> {
  const upper = epc.toUpperCase();
  const ts = now();

  return withTransaction(db, async () => {
    const rows = await db.select().from(tags).where(eq(tags.epc, upper));
    const row = rows[0];
    if (!row) {
      return { ok: false, message: `${upper} is not registered.`, epc: upper, tag: null, qty: 0 } satisfies AmendCheckinResult;
    }

    const set: Partial<TagRow> = {};
    const changes: string[] = [];

    for (const key of ["item_name", "sku", "mfc_date"] as const) {
      if (!(key in fields)) continue;
      const newVal = (fields[key] === null || fields[key] === undefined ? "" : String(fields[key])).trim();
      const oldVal = row[key] ?? "";
      if (newVal !== oldVal) {
        set[key] = newVal;
        changes.push(`${key}: '${oldVal}' -> '${newVal}'`);
      }
    }
    if ("quantity" in fields) {
      const newQty = asQuantity(fields.quantity);
      if (newQty !== row.quantity) {
        set.quantity = newQty;
        set.remaining = newQty;
        changes.push(`quantity: '${row.quantity}' -> '${newQty}'`);
      }
    }

    if (Object.keys(set).length > 0) {
      set.updated_at = ts;
      await db.update(tags).set(set).where(eq(tags.epc, upper));
      await logEvent(
        db,
        "EDIT",
        upper,
        row.item_type,
        row.bol_number,
        row.building,
        row.vendor,
        "check-in fix: " + changes.join("; "),
      );
    }

    const updatedRows = await db.select().from(tags).where(eq(tags.epc, upper));
    const updated = updatedRows[0];
    const qty = await groupInWarehouseQty(db, row.item_type, row.bol_number, row.building);
    return {
      ok: true,
      message: Object.keys(set).length > 0 ? `Updated ${upper}.` : "No changes.",
      tag: updated ? tagDict(updated) : null,
      qty,
    } satisfies AmendCheckinResult;
  });
}
