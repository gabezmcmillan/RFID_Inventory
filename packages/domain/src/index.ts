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
export { withTransaction } from "./db.js";
export type { DomainDb } from "./db.js";

// React-Native-safe migration runner + the checked-in migration bundle
export { applyMigrations } from "./applyMigrations.js";
export { MIGRATIONS } from "./migrations.js";
export type { MigrationEntry } from "./migrations.js";

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
} from "./schema.js";

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
} from "./constants.js";
export type { FieldDef, FieldScope, FieldType } from "./constants.js";

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
} from "./types.js";

// Repository: events
export { logEvent, listEvents } from "./repo/events.js";

// Repository: intake
export { allocateEpcs, amendCheckin, receiveShipment } from "./repo/intake.js";
export type { ItemFields } from "./repo/intake.js";

// Intake session (Check In armed-shipment state machine)
export { IntakeSession, NO_SHIPMENT_ARMED } from "./intakeSession.js";
export type { ArmedShipment, CheckInPrintedResult, CheckInScannedResult, PrintDeps } from "./intakeSession.js";

// Repository: checkout
export { deliverUnits, deliverUnitsInTx, lookupForCheckout } from "./repo/checkout.js";

// Repository: inventory
export {
  compareInventory,
  exportRows,
  findTag,
  groupTags,
  inventoryTree,
  itemNameSuggestions,
  recordInventory,
} from "./repo/inventory.js";

// Warehouse CSV export (column layout + RFC 4180 formatter)
export {
  csvEscape,
  csvRow,
  exportCsv,
  EXPORT_COLUMNS,
  EXPORT_HEADER_ROW,
} from "./repo/exportCsv.js";
export type { ExportColumn } from "./repo/exportCsv.js";

// Repository: vendors
export { addVendor, listVendors, removeVendor } from "./repo/vendors.js";

// Repository: notes
export { addNote, deleteNote, listNotes } from "./repo/notes.js";

// Repository: bol docs
export {
  applyBolExtraction,
  createBolDoc,
  deleteBolDoc,
  getBolDoc,
  listBolDocs,
  renameBolDoc,
  setBolDocPages,
} from "./repo/bolDocs.js";

// Repository: requests
export {
  countOpenRequests,
  createRequest,
  fulfillRequest,
  listRequests,
  setRequestStatus,
} from "./repo/requests.js";
export type { CreateRequestInput } from "./repo/requests.js";

// Repository: admin
export { clearAll, clearFlag, deleteGroup, updateTag } from "./repo/admin.js";
export type { UpdateTagFields } from "./repo/admin.js";

// Repository: local_meta key/value helpers
export { getMeta, setMeta } from "./repo/util.js";

// Label printing: ZPL builder (pure TS; the TCP transport lives in apps/field)
export { buildLabelZpl, descLayout, PrintError } from "./label/zpl.js";
export type { BuildLabelZplParams, DescLayout } from "./label/zpl.js";

// The legacy importer and the Node test harness live in their own modules
// (`src/importer/`, `src/testing/`) — separate, Node-only entries — so the main
// entry pulls no Node Turso driver. Import them directly:
//   - `./importer/importLegacy.js` (and `./importer/cli.js` for the CLI)
//   - `./testing/openTestDb.js` (`openTestDb`, `openTursoDb`, `wrapTurso`)
//   - `./migrate.js` (`migrateDb`)

