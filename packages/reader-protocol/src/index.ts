/**
 * `@rfid/reader-protocol` — the TSL ASCII 2.0 protocol engine, pure TypeScript.
 *
 * A behavioral port of `apps/warehouse/reader.py` minus threads and serial I/O:
 * line parsing, command building, burst finalization, mode side-effects, and
 * the finder proximity mapping. Never imports React Native — all hardware
 * interaction is injected into {@link ReaderSession}. See `plans/003-…md`.
 */

// Line tokenizing and classification
export { LineTokenizer, classifyLine, parseRssi } from "./lines.js";
export type { ReaderLine } from "./lines.js";

// Command builders + constants (mirror config.py)
export {
  CHECK_POWER_DEFAULT,
  FINDER_RSSI_MAX_DBM,
  FINDER_RSSI_MIN_DBM,
  INVENTORY_POWER,
  POWER_MAX,
  POWER_MIN,
  QUIET_GAP_SECONDS,
  alertFire,
  alertRestore,
  clampPower,
  finderMask,
  finderRestore,
  setBeep,
  setPower,
  setRssiOutput,
  switchNotifications,
} from "./commands.js";

// Events
export type {
  FinderEvent,
  FinderResetEvent,
  InventoryEvent,
  LiveEvent,
  ReaderEvent,
  ReaderMode,
  ScanEvent,
  StatusEvent,
} from "./events.js";

// Session
export { ReaderSession } from "./session.js";
export type { ReaderSessionDeps, SetModeOptions } from "./session.js";
