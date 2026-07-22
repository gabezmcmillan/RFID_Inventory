/**
 * Checkout repository: `lookupForCheckout` (db.py:744-769) and `deliverUnits`
 * (db.py:771-857). The core drawdown (`deliverUnitsInTx`) is exported so request
 * fulfillment can apply several draws inside one transaction.
 */

import { STATUS_DELIVERED, STATUS_PARTIAL } from "../constants.js";
import type { SqlDatabase } from "../sql.js";
import { withTransaction } from "../sql.js";
import type { DeliverUnitsResult, LookupForCheckoutResult, TagRow } from "../types.js";
import { logEvent } from "./events.js";
import { asQuantity, groupInWarehouseQty, now, today } from "./util.js";

/** Check Out step 1: look a box up for the two-step confirm UI (db.py:744-769). */
export async function lookupForCheckout(
  db: SqlDatabase,
  epc: string,
): Promise<LookupForCheckoutResult> {
  const upper = epc.toUpperCase();
  const row = await db.get<TagRow>("SELECT * FROM tags WHERE epc=?", [upper]);

  if (!row) {
    return { ok: false, message: `${upper} is not registered.`, epc: upper };
  }
  if (row.remaining <= 0) {
    return {
      ok: false,
      message: `${row.item_type} (${upper}) is already fully delivered.`,
      epc: upper,
      item_type: row.item_type,
      remaining: 0,
      quantity: row.quantity,
    };
  }

  return {
    ok: true,
    epc: upper,
    item_type: row.item_type,
    item_name: row.item_name,
    bol_number: row.bol_number,
    building: row.building,
    vendor: row.vendor,
    sku: row.sku,
    quantity: row.quantity,
    remaining: row.remaining,
  };
}

/**
 * Core of one checkout draw (db.py `_deliver_units_locked`). Caller wraps it in
 * a transaction and commits (so `fulfillRequest` can apply several draws in a
 * single transaction).
 *
 * `amount` is clamped to [1, remaining]; null/undefined means the whole box.
 * A box hitting 0 becomes `Delivered`, otherwise `Partial`. `delivered_at` is
 * stamped on every draw. If `checkoutBuilding` differs from the building the
 * box was received for, the tag is flagged and a `FLAG` event is logged.
 */
export async function deliverUnitsInTx(
  db: SqlDatabase,
  epc: string,
  amount?: number | null,
  checkoutBuilding?: string | null,
): Promise<DeliverUnitsResult> {
  const upper = epc.toUpperCase();
  const ts = now();
  const deliveredDate = today();
  const checkoutBldg = (checkoutBuilding ?? "").toString().trim();

  const row = await db.get<TagRow>("SELECT * FROM tags WHERE epc=?", [upper]);

  if (!row) {
    await logEvent(db, "OUT", upper, "UNKNOWN", "", "", "", "not registered");
    return { ok: false, message: `${upper} is not registered.`, epc: upper };
  }

  const remaining = row.remaining;
  if (remaining <= 0) {
    return {
      ok: false,
      message: `${row.item_type} (${upper}) is already fully delivered.`,
      epc: upper,
      item_type: row.item_type,
    };
  }

  const rawTake = amount === null || amount === undefined ? remaining : asQuantity(amount);
  const take = Math.max(1, Math.min(rawTake, remaining));
  const newRemaining = remaining - take;
  const newStatus = newRemaining === 0 ? STATUS_DELIVERED : STATUS_PARTIAL;
  const deliveredAt = ts;

  const mismatch = Boolean(checkoutBldg && row.building && checkoutBldg !== row.building);
  let flag = "";
  if (mismatch) {
    flag = `Checked out to Bldg ${checkoutBldg} but received for Bldg ${row.building}`;
  }

  const sets = ["remaining=?", "status=?", "delivered_at=?", "updated_at=?"];
  const params: unknown[] = [newRemaining, newStatus, deliveredAt, ts];
  if (checkoutBldg) {
    sets.push("checkout_building=?");
    params.push(checkoutBldg);
  }
  if (mismatch) {
    sets.push("flag=?", "flagged_at=?");
    params.push(flag, ts);
  }
  params.push(upper);
  await db.run(`UPDATE tags SET ${sets.join(", ")} WHERE epc=?`, params);

  const dest = checkoutBldg ? ` to Bldg ${checkoutBldg}` : "";
  await logEvent(
    db,
    "OUT",
    upper,
    row.item_type,
    row.bol_number,
    row.building,
    row.vendor,
    `delivered ${take} unit(s)${dest}, ${newRemaining} left`,
  );
  if (mismatch) {
    await logEvent(db, "FLAG", upper, row.item_type, row.bol_number, row.building, row.vendor, flag);
  }
  const qtyRemaining = await groupInWarehouseQty(db, row.item_type, row.bol_number, row.building);

  return {
    ok: true,
    message: `Delivered ${take} unit(s) of ${row.item_type} (${upper}) to site.`,
    epc: upper,
    item_type: row.item_type,
    bol_number: row.bol_number,
    building: row.building,
    checkout_building: checkoutBldg,
    flag,
    delivered: take,
    box_remaining: newRemaining,
    box_status: newStatus,
    delivered_at: deliveredDate,
    qty_remaining: qtyRemaining,
  };
}

/** Check Out step 2: draw `amount` units out of a box and commit (db.py:771-783). */
export async function deliverUnits(
  db: SqlDatabase,
  epc: string,
  amount?: number | null,
  checkoutBuilding?: string | null,
): Promise<DeliverUnitsResult> {
  return withTransaction(db, () => deliverUnitsInTx(db, epc, amount, checkoutBuilding));
}
