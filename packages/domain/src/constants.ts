/**
 * Domain constants, ported from `apps/warehouse/config.py:218-256` (item types
 * and field definitions) and `apps/warehouse/db.py:39-51` (status / request
 * lifecycle constants). Keep these names in code: the web UI, printed labels,
 * and operator muscle memory depend on the exact strings.
 *
 * "Item No." is the user-facing label for the `sku` key/column.
 */

// -- Tag status (db.py:39-41) -------------------------------------------------
export const STATUS_IN = "In Warehouse";
export const STATUS_DELIVERED = "Delivered";
export const STATUS_PARTIAL = "Partial";

// -- Material-request lifecycle (db.py:46-51) --------------------------------
export const REQUEST_PENDING = "pending";
export const REQUEST_STAGING = "staging";
export const REQUEST_FULFILLED = "fulfilled";
export const REQUEST_DECLINED = "declined";
export const REQUEST_STATUSES = [
  REQUEST_PENDING,
  REQUEST_STAGING,
  REQUEST_FULFILLED,
  REQUEST_DECLINED,
] as const;

// -- Warehouse grouping dimensions (db.py:54) --------------------------------
/** UI group_by values mapped to their tag column. */
export const GROUP_COLUMNS: Record<string, string> = {
  bol: "bol_number",
  building: "building",
};

// -- EPC minting (config.py:147, db.py:340) -----------------------------------
/** App-minted EPC prefix (hex: ASCII "BG01"). Factory tags keep their own EPC. */
export const PRINTER_EPC_PREFIX = "42473031";
/** 96-bit EPC, in hex characters. */
export const EPC_LENGTH = 24;
/**
 * New multi-device layout (plan 002 standing decision):
 *   EPC = PRINTER_EPC_PREFIX (8 hex) + device id (2 hex) + per-device serial (14 hex)
 * Legacy EPCs are prefix (8) + global serial (16); the importer keeps them as-is.
 */
export const EPC_PREFIX_LEN = 8;
export const EPC_DEVICE_LEN = 2;
export const EPC_SERIAL_LEN = 14;

// -- Item types and check-in fields (config.py:218-256) ----------------------
export const ITEM_TYPES = ["TSC", "CDU", "W.I.F."];
/** Types whose boxes carry a per-unit component name; group by it in the view. */
export const NAMED_ITEM_TYPES = ["W.I.F."];

export const BUILDING_OPTIONS = ["6", "7", "8"];
/** Seeds the vendor list on first run (empty by default). */
export const DEFAULT_VENDORS: string[] = [];

export type FieldScope = "shipment" | "item";
export type FieldType = "text" | "buttons" | "select" | "date" | "number";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  scope: FieldScope;
  options?: string[];
  suggest?: boolean;
}

export const SHIPMENT_FIELDS: FieldDef[] = [
  { key: "building_number", label: "Building #", type: "buttons", options: BUILDING_OPTIONS, scope: "shipment" },
  { key: "sector", label: "Sector", type: "text", scope: "shipment" },
  { key: "bol_number", label: "BOL Number", type: "text", scope: "shipment" },
  { key: "po_number", label: "PO Number", type: "text", scope: "shipment" },
  { key: "vendor", label: "Vendor", type: "select", scope: "shipment" },
];

export const ITEM_FIELDS: FieldDef[] = [
  { key: "sku", label: "Item No.", type: "text", scope: "item" },
  { key: "mfc_date", label: "Manufactured Date", type: "date", scope: "item" },
  { key: "quantity", label: "Quantity (units in this box)", type: "number", scope: "item" },
];

export const COMMON_FIELDS: FieldDef[] = [...SHIPMENT_FIELDS, ...ITEM_FIELDS];

export const ITEM_NAME_FIELD: FieldDef = {
  key: "item_name",
  label: "Item Name",
  type: "text",
  scope: "item",
  suggest: true,
};

/** Per-type field set: named types add the Item Name field ahead of the item fields. */
export const TYPE_FIELDS: Record<string, FieldDef[]> = Object.fromEntries(
  ITEM_TYPES.map((t) => [
    t,
    NAMED_ITEM_TYPES.includes(t)
      ? [...SHIPMENT_FIELDS, ITEM_NAME_FIELD, ...ITEM_FIELDS]
      : COMMON_FIELDS,
  ]),
);

// -- Event-log filter categories (db.py:1115) --------------------------------
export const EVENT_FILTERS: Record<string, string[]> = {
  checkin: ["IN"],
  checkout: ["OUT"],
  scan: ["COUNT"],
};

// -- Admin-editable tag fields (db.py:1214-1216) ------------------------------
export const EDITABLE_FIELDS = [
  "item_type",
  "item_name",
  "bol_number",
  "po_number",
  "building",
  "sector",
  "vendor",
  "sku",
  "mfc_date",
  "quantity",
  "remaining",
  "status",
] as const;

/** Operator-correctable per-unit fields right after check-in (intake.py:42). */
export const AMENDABLE_FIELDS = ["item_name", "sku", "mfc_date", "quantity"] as const;
