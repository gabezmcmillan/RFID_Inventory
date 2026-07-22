/**
 * `@rfid/domain` — the single source of warehouse domain truth.
 *
 * Pure TypeScript over the {@link SqlDatabase} interface; runs unchanged on the
 * device (Turso React Native), in Node tests, and in the importer. Never
 * imports React Native.
 */

// SQL surface + transaction helper
export { withTransaction } from "./sql.js";
export type { RunResult, SqlDatabase } from "./sql.js";

// Schema
export { SCHEMA_SQL, applySchema } from "./schema.js";

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

// Types
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

// Node test harness (Node-only; not imported by repository code)
export { openTestDb, openTursoSql, wrapTurso } from "./testing/openTestDb.js";
