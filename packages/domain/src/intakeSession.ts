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

import type { DomainDb } from "./db";
import { allocateEpcs, amendCheckin, receiveShipment } from "./repo/intake";
import type { EpcSerialAllocator, ItemFields } from "./repo/intake";
import { buildLabelZpl } from "./label/zpl";
import { MAX_LABELS_PER_PRINT } from "./constants";
import type { AmendCheckinResult, ReceiveShipmentResult } from "./types";

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
 * Injected print-path dependencies (intake.py:87-140). The field app supplies
 * `printLabel` — typically `zpl => sendZpl(host, 9100, zpl)` — so the domain
 * never imports the React-Native TCP transport. `cloudBaseUrl` builds the
 * label QR URL (`{cloudBaseUrl}/tag/{epc}`); empty means no QR.
 */
export interface PrintDeps {
  /** Send one built ZPL job to the printer; reject on any failure. */
  readonly printLabel: (zpl: string) => Promise<void>;
  /** Cloud base URL for label QR codes, or "" to omit the QR block. */
  readonly cloudBaseUrl: string;
}

/**
 * Result of a print-path Check In. On total failure (no label printed) it is
 * `{ok:false, message:"Label not printed: <err>"}`; otherwise a
 * {@link ReceiveShipmentResult} carrying `printed` (how many labels printed)
 * and, on a partial print, the "Printing stopped after N of M labels" suffix.
 */
export type CheckInPrintedResult =
  | { readonly ok: false; readonly message: string }
  | (ReceiveShipmentResult & { readonly ok: true; readonly printed: number });

/**
 * Message returned by {@link IntakeSession.checkInScanned} when no shipment is
 * armed. Exported as the single source of truth so the UI and tests reference
 * the constant rather than duplicating the literal.
 */
export const NO_SHIPMENT_ARMED = "No shipment armed for check-in.";

/**
 * Coerce a `bol_doc_id` field value to a non-empty string, or `null`. The id is
 * a global text ID (UUIDv4) since plan 010 Phase 2; blank/invalid input maps to
 * `null` so the tag is filed without a linked document.
 */
function asDocId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/** Format a Date as `MM/DD/YYYY` (intake.py `now.strftime("%m/%d/%Y")`). */
function formatReceivedDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/** Format a Date as `H:MM AM/PM` without a leading zero (intake.py `strftime("%I:%M %p").lstrip("0")`). */
function formatReceivedTime(d: Date): string {
  const raw = d.getHours() % 12;
  const h = raw === 0 ? 12 : raw;
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ampm = d.getHours() < 12 ? "AM" : "PM";
  return `${h}:${mm} ${ampm}`;
}

/**
 * Owns the armed-shipment state for Check In. Keep one instance per field app
 * (a singleton in the field app — see plan 004 maintenance notes); the check-in
 * UI and (plan 005) the print path share it.
 */
export class IntakeSession {
  private _armed: ArmedShipment | null = null;
  private _itemFields: ItemFields = {};
  private readonly _allocator: EpcSerialAllocator;

  /**
   * @param allocator Source of this device's permanent 2-hex id and its
   *   monotonic EPC serial counter (a local-only device DB on-device). The
   *   print path reserves serials atomically before printing labels.
   */
  constructor(allocator: EpcSerialAllocator) {
    this._allocator = allocator;
  }

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
    return this.receive(db, [epc], armed.itemType, armed.fields, this._itemFields);
  }

  /**
   * Record a shipment's tags under the armed shipment — the shared recording
   * path for both check-in entry points (intake.py `_receive`, lines 154-163).
   * Maps the shipment fields exactly as the Python original.
   */
  private async receive(
    db: DomainDb,
    epcs: readonly string[],
    itemType: string,
    fields: Record<string, string>,
    itemFields: ItemFields,
  ): Promise<ReceiveShipmentResult> {
    return receiveShipment(
      db,
      [...epcs],
      itemType,
      fields.building_number ?? "",
      fields.bol_number ?? "",
      fields.vendor ?? "",
      itemFields,
      asDocId(fields.bol_doc_id),
      fields.po_number ?? "",
      fields.sector ?? "",
    );
  }

  /**
   * Print-path Check In (intake.py `check_in_printed`, lines 87-140): mint
   * `count` EPCs, print + encode a label per EPC, and record **only** the
   * labels that actually printed — so a dead printer never creates phantom
   * inventory. `count` is clamped to `[1, {@link MAX_LABELS_PER_PRINT}]`.
   *
   * Named types (W.I.F.) print `"TYPE | component name"` as the description.
   * EPCs are minted up front via {@link allocateEpcs}; labels are then sent
   * sequentially via {@link PrintDeps.printLabel}, stopping at the first
   * rejection. With none printed → `{ok:false, message:"Label not printed: <err>"}`;
   * with some printed the recorded result carries `printed` and, on a partial
   * print, the `"Printing stopped after N of M labels: <err>"` suffix.
   *
   * The session must be armed (the print path records under the armed
   * shipment); returns the "no shipment armed" message otherwise.
   */
  async checkInPrinted(
    db: DomainDb,
    deps: PrintDeps,
    count = 1,
  ): Promise<CheckInPrintedResult> {
    const armed = this._armed;
    if (!armed) {
      return { ok: false, message: NO_SHIPMENT_ARMED };
    }
    const clamped = Math.max(1, Math.min(count || 1, MAX_LABELS_PER_PRINT));
    const fields = armed.fields;
    const itemFields = this._itemFields;
    const itemName = (itemFields.item_name ?? "").toString().trim();
    const description = itemName ? `${armed.itemType} | ${itemName}` : armed.itemType;
    const now = new Date();
    const receivedDate = formatReceivedDate(now);
    const receivedTime = formatReceivedTime(now);
    const cloudBase = deps.cloudBaseUrl.trim().replace(/\/+$/, "");

    const epcs = await allocateEpcs(db, clamped, this._allocator);
    const printed: string[] = [];
    let printError = "";
    for (const epc of epcs) {
      const zpl = buildLabelZpl({
        epc,
        building: fields.building_number ?? "",
        sector: fields.sector ?? "",
        description,
        supplier: fields.vendor ?? "",
        sku: itemFields.sku ?? "",
        quantity: String(itemFields.quantity || "1"),
        poNumber: fields.po_number ?? "",
        receivedDate,
        receivedTime,
        qrUrl: cloudBase ? `${cloudBase}/tag/${epc}` : "",
      });
      try {
        await deps.printLabel(zpl);
        printed.push(epc);
      } catch (err) {
        printError = err instanceof Error ? err.message : String(err);
        break;
      }
    }

    if (printed.length === 0) {
      return { ok: false, message: `Label not printed: ${printError}` };
    }
    const result = await this.receive(db, printed, armed.itemType, fields, itemFields);
    const withPrinted: ReceiveShipmentResult & { ok: true; printed: number } = {
      ...result,
      ok: true as const,
      printed: printed.length,
    };
    if (printError) {
      withPrinted.message += ` Printing stopped after ${printed.length} of ${clamped} labels: ${printError}`;
    }
    return withPrinted;
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
