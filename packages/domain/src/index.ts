/**
 * `@rfid/domain` — the single source of warehouse domain truth.
 *
 * Pure TypeScript over a Drizzle {@link DomainDb}; runs unchanged on the
 * device (Turso React Native, via `drizzle-orm/tursodatabase-sync`), in Node
 * tests, and in the importer. Never imports React Native. The Node-only Turso
 * driver and test harness live in `src/testing/` (a separate entry) so the main
 * entry stays driver-free.
 */

// Drizzle database type + transaction helper
export { withTransaction } from "./db";
export type { DomainDb } from "./db";

// React-Native-safe migration runner + the checked-in migration bundle
export { applyMigrations } from "./applyMigrations";
export { MIGRATIONS } from "./migrations";
export type { MigrationEntry } from "./migrations";

/**
 * The schema version this build understands = the number of migrations in the
 * checked-in bundle. Plan 010 Phase 3: the sync coordinator compares this
 * against the server's synced `schema_version` meta row and blocks writes
 * (upgrade required) when the server is ahead of what this build supports.
 */
import { MIGRATIONS } from "./migrations";
export const SCHEMA_VERSION: number = MIGRATIONS.length;

// RN-safe global text-ID helper (UUIDv4) for collision-free field-created rows
export { newId } from "./id";

// Schema (source of truth) — tables + the schema bundle
export {
  bolDocs,
  events,
  localMeta,
  notes,
  requests,
  schema,
  tags,
  vendors,
} from "./schema";

// Constants
export {
  AMENDABLE_FIELDS,
  BUILDING_OPTIONS,
  COMMON_FIELDS,
  DEFAULT_VENDORS,
  EDITABLE_FIELDS,
  EPC_DEVICE_LEN,
  EPC_LENGTH,
  EPC_PREFIX_LEN,
  EPC_SERIAL_LEN,
  EVENT_FILTERS,
  GROUP_COLUMNS,
  ITEM_FIELDS,
  ITEM_NAME_FIELD,
  ITEM_TYPES,
  MAX_LABELS_PER_PRINT,
  NAMED_ITEM_TYPES,
  PRINTER_EPC_PREFIX,
  REQUEST_DECLINED,
  REQUEST_FULFILLED,
  REQUEST_PENDING,
  REQUEST_STAGING,
  REQUEST_STATUSES,
  SHIPMENT_FIELDS,
  STATUS_DELIVERED,
  STATUS_IN,
  STATUS_PARTIAL,
  TYPE_FIELDS,
} from "./constants";
export type { FieldDef, FieldScope, FieldType } from "./constants";

// Types (row types inferred from the schema; the rest are domain-level shapes)
export type {
  AddNoteResult,
  AmendCheckinResult,
  BolDoc,
  BolDocWithBoxes,
  BolLineItem,
  ClearAllResult,
  ClearFlagResult,
  CompareInventoryResult,
  CreateRequestResult,
  DeleteBolDocResult,
  DeleteGroupResult,
  DeleteNoteResult,
  DeliverUnitsResult,
  EventRow,
  FlaggedTag,
  FulfillDraw,
  FulfillRequestResult,
  GroupTagsResult,
  InventoryFilters,
  InventoryGroup,
  InventoryTreeResult,
  InventoryType,
  LookupForCheckoutResult,
  MaterialRequest,
  Note,
  ReceiveShipmentResult,
  RenameBolDocResult,
  SetRequestStatusResult,
  Tag,
  TagRow,
  UpdateTagResult,
  VendorResult,
} from "./types";

// Repository: events
export { logEvent, listEvents } from "./repo/events";

// Repository: intake
export { allocateEpcs, amendCheckin, makeInMemoryEpcAllocator, receiveShipment } from "./repo/intake";
export type { EpcSerialAllocator, ItemFields } from "./repo/intake";

// Intake session (Check In armed-shipment state machine)
export { IntakeSession, NO_SHIPMENT_ARMED } from "./intakeSession";
export type { ArmedShipment, CheckInPrintedResult, CheckInScannedResult, PrintDeps } from "./intakeSession";

// Repository: checkout
export { deliverUnits, deliverUnitsInTx, lookupForCheckout } from "./repo/checkout";

// Repository: inventory
export {
  compareInventory,
  exportRows,
  findTag,
  groupTags,
  inventoryTree,
  itemNameSuggestions,
  recordInventory,
} from "./repo/inventory";

// Warehouse CSV export (column layout + RFC 4180 formatter)
export {
  csvEscape,
  csvRow,
  exportCsv,
  EXPORT_COLUMNS,
  EXPORT_HEADER_ROW,
} from "./repo/exportCsv";
export type { ExportColumn } from "./repo/exportCsv";

// Repository: vendors
export { addVendor, listVendors, removeVendor } from "./repo/vendors";

// Repository: notes
export { addNote, deleteNote, listNotes } from "./repo/notes";

// Repository: bol docs
export {
  applyBolExtraction,
  createBolDoc,
  deleteBolDoc,
  getBolDoc,
  listBolDocs,
  renameBolDoc,
  setBolDocPages,
  setBolDocStorageUrl,
} from "./repo/bolDocs";

// Repository: requests
export {
  countOpenRequests,
  createRequest,
  fulfillRequest,
  listRequests,
  setRequestStatus,
} from "./repo/requests";
export type { CreateRequestInput } from "./repo/requests";

// Repository: web jobsite (stock browse, cart, orders, counts)
export {
  buildings,
  counts,
  createCartRequest,
  lastUpdated,
  listOrders,
  newOrderRef,
  nowUtc,
  parseStrictQuantity,
  stockRows,
} from "./repo/webStock";
export type {
  CartLineError,
  CartLineInput,
  CartOkResult,
  CartErrResult,
  Counts,
  CreateCartRequestResult,
  Order,
  StockComponent,
  StockGroup,
  StockRow,
} from "./repo/webStock";

// Repository: admin
export { clearAll, clearFlag, deleteGroup, updateTag } from "./repo/admin";
export type { UpdateTagFields } from "./repo/admin";

// Repository: local_meta key/value helpers
export { getMeta, setMeta } from "./repo/util";

// Label printing: ZPL builder (pure TS; the TCP transport lives in apps/field)
export { buildLabelZpl, descLayout, PrintError } from "./label/zpl";
export type { BuildLabelZplParams, DescLayout } from "./label/zpl";

// BOL extraction: local heuristics (pure TS; the Mistral client lives in
// `./bol/mistral.js` and is imported directly where needed)
export { cleanValue, extractFields, matchVendor, sequenceRatio } from "./bol/extract";
export type { ExtractedFields } from "./bol/extract";

// BOL extraction: Mistral OCR cloud client (pure TS; takes `fetchImpl` so the
// domain package never assumes a fetch global)
export { extractFieldsViaMistral } from "./bol/mistral";
export type { ExtractViaMistralInput, FetchImpl, MistralDocument, MistralExtraction, MistralLineItem } from "./bol/mistral";

// The legacy importer and the Node test harness live in their own modules
// (`src/importer/`, `src/testing/`) — separate, Node-only entries — so the main
// entry pulls no Node Turso driver. Import them directly:
//   - `./importer/importLegacy.js` (and `./importer/cli.js` for the CLI)
//   - `./testing/openTestDb.js` (`openTestDb`, `openTursoDb`, `wrapTurso`)
//   - `./migrate.js` (`migrateDb`)

