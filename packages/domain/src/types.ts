/**
 * Domain-level types for the domain package.
 *
 * Row types that duplicate a table's shape are inferred from the Drizzle schema
 * (`typeof tags.$inferSelect` etc.) and re-exported under the names the public
 * API already uses, so `src/index.ts` keeps stable names. Genuinely domain-level
 * types — enum/union literals, computed result shapes (inventory tree nodes,
 * importer report types, the public tag dict, the coalesced event row) — stay
 * hand-written here.
 */

import type { notes, requests, tags } from "./schema.js";

// -- tags ---------------------------------------------------------------------
/** Full `tags` row as stored (inferred from the Drizzle schema). */
export type TagRow = typeof tags.$inferSelect;

/** Public tag dict (Python `_tag_dict`, db.py:316-337): no id/created/updated. */
export interface Tag {
  epc: string;
  item_type: string;
  item_name: string;
  bol_number: string;
  po_number: string;
  bol_doc_id: number | null;
  building: string;
  sector: string;
  vendor: string;
  sku: string;
  mfc_date: string;
  quantity: number;
  remaining: number;
  status: string;
  received_at: string;
  delivered_at: string;
  checkout_building: string;
  flag: string;
  flagged_at: string;
}

// -- events ------------------------------------------------------------------
/** Public event row (Python `list_events` coalesces nullable columns to ""). */
export interface EventRow {
  id: number;
  ts: string;
  action: string;
  epc: string;
  item_type: string;
  bol_number: string;
  building: string;
  vendor: string;
  detail: string;
}

// -- bol_docs ----------------------------------------------------------------
export interface BolLineItem {
  item_no: string;
  item_name: string;
}

/** Public BOL doc dict (Python `_bol_doc_dict`) plus the new `storage_url`. */
export interface BolDoc {
  id: number;
  bol_number: string;
  filename: string;
  source: string;
  pages: number;
  vendor: string;
  po_number: string;
  line_items: BolLineItem[];
  auto_named: boolean;
  created_at: string;
  storage_url: string;
}

/** `list_bol_docs` adds the linked box count to each doc. */
export type BolDocWithBoxes = BolDoc & { boxes: number };

// -- notes -------------------------------------------------------------------
/** `notes` row as stored (inferred from the Drizzle schema). */
export type Note = typeof notes.$inferSelect;

// -- requests ----------------------------------------------------------------
/** `requests` row as stored (inferred from the Drizzle schema). */
export type MaterialRequest = typeof requests.$inferSelect;

// -- intake results -----------------------------------------------------------
export interface ReceiveShipmentResult {
  ok: boolean;
  message: string;
  added: number;
  added_units: number;
  /** Units per box (the quantity each inserted tag carries). */
  quantity: number;
  duplicates: string[];
  epcs: string[];
  /** First inserted EPC, or "" if none. */
  epc: string;
  /** Group units still in the warehouse after the draw. */
  qty: number;
  item_type: string;
  item_name: string;
  bol_number: string;
  po_number: string;
  bol_doc_id: number | null;
  building: string;
  sector: string;
  vendor: string;
  sku: string;
  mfc_date: string;
}

export interface AmendCheckinResult {
  ok: boolean;
  message: string;
  epc?: string;
  tag: Tag | null;
  qty: number;
}

// -- checkout results ---------------------------------------------------------
export interface LookupForCheckoutResult {
  ok: boolean;
  message?: string;
  epc: string;
  item_type?: string;
  item_name?: string;
  bol_number?: string;
  building?: string;
  vendor?: string;
  sku?: string;
  quantity?: number;
  remaining?: number;
}

export interface DeliverUnitsResult {
  ok: boolean;
  message: string;
  epc: string;
  item_type?: string;
  bol_number?: string;
  building?: string;
  checkout_building?: string;
  flag?: string;
  delivered?: number;
  box_remaining?: number;
  box_status?: string;
  delivered_at?: string;
  qty_remaining?: number;
}

// -- inventory results --------------------------------------------------------
export interface FlaggedTag {
  epc: string;
  item_type: string;
  bol_number: string;
  building: string;
  delivered_at: string;
  flag: string;
}

export interface RecordInventoryResult {
  counts: Record<string, number>;
  unknown: string[];
  flagged: FlaggedTag[];
  items: Tag[];
  total: number;
}

export interface CompareInventoryResult {
  expected: number;
  found_count: number;
  missing_count: number;
  missing: Tag[];
  found_epcs: string[];
}

export interface InventoryGroup {
  value: string;
  in_wh: number;
  capacity: number;
  boxes: number;
  flagged: number;
  received_at: string;
  bol_doc_id: number | null;
  note_count: number;
  qty: number;
  total: number;
  received: string;
  status: string;
  other_values: string[];
  vendors: string[];
}

export interface InventoryType {
  item_type: string;
  named: boolean;
  qty: number;
  groups: InventoryGroup[];
}

export interface InventoryTreeResult {
  group_by: string;
  types: InventoryType[];
}

export interface GroupTagsResult {
  item_type: string;
  group_by: string;
  value: string;
  tags: Tag[];
}

// -- admin results ------------------------------------------------------------
export interface DeleteGroupResult {
  ok: boolean;
  removed: number;
  message: string;
}

export interface ClearAllResult {
  ok: boolean;
  removed: number;
  /** BOL filenames the caller should delete from blob storage / disk. */
  bol_files: string[];
  message: string;
}

export interface UpdateTagResult {
  ok: boolean;
  message: string;
  epc?: string;
  tag?: Tag;
}

export interface ClearFlagResult {
  ok: boolean;
  message: string;
  epc?: string;
  tag?: Tag;
}

// -- note results -------------------------------------------------------------
export interface AddNoteResult {
  ok: boolean;
  message: string;
  note?: Note;
}

export interface DeleteNoteResult {
  ok: boolean;
  message: string;
}

// -- bol-doc results ----------------------------------------------------------
export interface DeleteBolDocResult {
  ok: boolean;
  message: string;
  unlinked: number;
  /** Filename the caller should delete from storage (no os.remove here). */
  filename?: string;
  id: number;
}

export interface RenameBolDocResult {
  ok: boolean;
  message: string;
  doc?: BolDoc;
  tags_updated?: number;
}

// -- vendor results -----------------------------------------------------------
export interface VendorResult {
  ok: boolean;
  message: string;
  vendors: string[];
}

// -- request results ----------------------------------------------------------
export interface CreateRequestResult {
  ok: boolean;
  message: string;
  request?: MaterialRequest;
}

export interface SetRequestStatusResult {
  ok: boolean;
  message: string;
  request?: MaterialRequest;
}

export interface FulfillDraw {
  epc: string;
  amount?: number | null;
  building?: string;
}

export interface FulfillRequestResult {
  ok: boolean;
  message: string;
  note_required?: boolean;
  delivered?: number;
  requested?: number;
  short?: boolean;
  results: DeliverUnitsResult[];
  request?: MaterialRequest;
}

// -- warehouse filters (db.py:926-955) ----------------------------------------
export interface InventoryFilters {
  bol?: string;
  building?: string;
  received_from?: string;
  received_to?: string;
  checked_out_from?: string;
  checked_out_to?: string;
}
