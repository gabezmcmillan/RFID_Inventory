/**
 * Intake repository: `receiveShipment` (db.py:371-434), `amendCheckin`
 * (db.py:436-486), and `allocateEpcs` (db.py:342-369) with the new
 * multi-device EPC layout (plan 002 standing decision).
 */

import { eq } from "drizzle-orm";

import {
  EPC_DEVICE_LEN,
  EPC_SERIAL_LEN,
  PRINTER_EPC_PREFIX,
  STATUS_IN,
} from "../constants";
import type { DomainDb } from "../db";
import { withTransaction } from "../db";
import { tags } from "../schema";
import type { AmendCheckinResult, ReceiveShipmentResult, Tag, TagRow } from "../types";
import { logEvent } from "./events";
import {
  asQuantity,
  getMeta,
  groupInWarehouseQty,
  now,
  setMeta,
  tagDict,
} from "./util";

/** Per-unit item fields accepted at check-in. */
export interface ItemFields {
  item_name?: string | null;
  sku?: string | null;
  mfc_date?: string | null;
  quantity?: unknown;
}

function normalizeDeviceId(value: string): string {
  const hex = value.toUpperCase().padStart(EPC_DEVICE_LEN, "0");
  return hex.slice(0, EPC_DEVICE_LEN);
}

/**
 * Mint unique EPCs for printer-encoded labels (db.py:342-369).
 *
 * New layout: `EPC = PRINTER_EPC_PREFIX (8 hex) + device id (2 hex) +
 * per-device serial (14 hex)`. The serial persists in `local_meta`
 * (`epc_serial`); any value that already exists in `tags` is skipped, so an
 * allocated EPC is never a duplicate.
 *
 * `deviceId` is this device's 2-hex id; tests pass it explicitly (plan 010
 * assigns `local_meta.device_id` on first run).
 */
export async function allocateEpcs(
  db: DomainDb,
  count = 1,
  deviceId = "",
): Promise<string[]> {
  const prefix = PRINTER_EPC_PREFIX.toUpperCase();
  const dev = normalizeDeviceId(deviceId || (await getMeta(db, "device_id")) || "00");
  let serial = Number.parseInt((await getMeta(db, "epc_serial")) ?? "0", 10);
  if (!Number.isFinite(serial) || serial < 0) serial = 0;

  const epcs: string[] = [];
  while (epcs.length < count) {
    serial += 1;
    const epc =
      prefix +
      dev +
      serial.toString(16).toUpperCase().padStart(EPC_SERIAL_LEN, "0");
    const existing = await db
      .select({ epc: tags.epc })
      .from(tags)
      .where(eq(tags.epc, epc));
    if (existing.length === 0) epcs.push(epc);
  }
  await setMeta(db, "epc_serial", String(serial));
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
  bolDocId: number | null = null,
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
