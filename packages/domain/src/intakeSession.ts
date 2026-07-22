/**
 * `IntakeSession` — the armed-shipment state machine for Check In, a class
 * port of `apps/warehouse/intake.py`'s `ShipmentIntake` minus the print path
 * (plan 005 adds printing).
 *
 * The armed shipment (`{itemType, fields}`) and the per-unit item fields for
 * the next tag live here, not on the reader: the reader emits only the EPC it
 * picked from a burst; meaning lives in intake. Arm/scan/amend calls come
 * from the UI, so — unlike the Python original — no lock is needed (the field
 * app is single-threaded over JS).
 *
 * One recording rule, two entry points:
 *   - `checkInScanned(db, epc)` — handheld path: one trigger-pull EPC.
 *   - `amend(db, epc, fields)`    — operator fix of the just-scanned tag
 *     (item name / Item No. / mfc date / qty), not PIN-gated.
 *
 * The session stays armed after each scan so more units can be tagged in; only
 * `disarm()` (or arming a new shipment) clears it.
 */

import type { DomainDb } from "./db.js";
import { amendCheckin, receiveShipment } from "./repo/intake.js";
import type { ItemFields } from "./repo/intake.js";
import type { AmendCheckinResult, ReceiveShipmentResult } from "./types.js";

/** The armed shipment: an item type plus its shipment-scope fields. */
export interface ArmedShipment {
  readonly itemType: string;
  readonly fields: Record<string, string>;
}

/** Result of a handheld Check In scan. */
export type CheckInScannedResult =
  | { readonly ok: false; readonly message: string }
  | ReceiveShipmentResult;

/**
 * Message returned by {@link IntakeSession.checkInScanned} when no shipment is
 * armed. Exported as the single source of truth so the UI and tests reference
 * the constant rather than duplicating the literal.
 */
export const NO_SHIPMENT_ARMED = "No shipment armed for check-in.";

/**
 * Coerce a `bol_doc_id` field value to a positive int, or `null` (intake.py
 * `_as_doc_id`). Blank/invalid/non-positive input maps to `null`.
 */
function asDocId(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Owns the armed-shipment state for Check In. Keep one instance per field app
 * (a singleton in the field app — see plan 004 maintenance notes); the check-in
 * UI and (plan 005) the print path share it.
 */
export class IntakeSession {
  private _armed: ArmedShipment | null = null;
  private _itemFields: ItemFields = {};

  /** Arm check-in for a shipment; scanned tags file under these fields. Clears per-unit item fields. */
  arm(itemType: string, fields: Record<string, string> = {}): void {
    this._armed = { itemType, fields: { ...fields } };
    this._itemFields = {};
  }

  /** Disarm: no shipment is armed and per-unit item fields are cleared. */
  disarm(): void {
    this._armed = null;
    this._itemFields = {};
  }

  /** Set the per-unit item fields (Item No., mfc date, quantity, item name) for the next tag. */
  setItemFields(fields: ItemFields = {}): void {
    this._itemFields = { ...fields };
  }

  /** The currently armed shipment, or `null` when disarmed. */
  getArmed(): ArmedShipment | null {
    return this._armed;
  }

  /**
   * Record one trigger-pull tag under the armed shipment (intake.py
   * `check_in_scanned`). Returns the "no shipment armed" message when
   * disarmed; otherwise calls {@link receiveShipment} with the armed
   * shipment and the current per-unit item fields, mapping the shipment
   * fields exactly as `intake.py:154-163`.
   *
   * The session stays armed on success so more units can be tagged in.
   */
  async checkInScanned(db: DomainDb, epc: string): Promise<CheckInScannedResult> {
    const armed = this._armed;
    if (!armed) {
      return { ok: false, message: NO_SHIPMENT_ARMED };
    }
    const f = armed.fields;
    return receiveShipment(
      db,
      [epc],
      armed.itemType,
      f.building_number ?? "",
      f.bol_number ?? "",
      f.vendor ?? "",
      this._itemFields,
      asDocId(f.bol_doc_id),
      f.po_number ?? "",
      f.sector ?? "",
    );
  }

  /**
   * Operator correction of a just-checked-in tag (intake.py `amend`). Copies
   * only the amendable fields (`item_name` / `sku` / `mfc_date` / `quantity` —
   * the full {@link ItemFields} set, per {@link AMENDABLE_FIELDS}) from
   * `fields`, dropping any extra runtime keys the UI should never send, then
   * delegates to {@link amendCheckin}. Not PIN-gated.
   */
  async amend(
    db: DomainDb,
    epc: string,
    fields: ItemFields,
  ): Promise<AmendCheckinResult> {
    const allowed: ItemFields = {
      item_name: fields.item_name,
      sku: fields.sku,
      mfc_date: fields.mfc_date,
      quantity: fields.quantity,
    };
    return amendCheckin(db, epc, allowed);
  }
}
