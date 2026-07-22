/**
 * The reader event union — the set of events a {@link ReaderSession} emits.
 * Matches the Python `on_event` payloads in `apps/warehouse/reader.py`.
 */

/** Reader mode. `reader.py:IDLE/CHECKIN/CHECKOUT/INVENTORY/FINDER`. */
export type ReaderMode = "idle" | "checkin" | "checkout" | "inventory" | "finder";

/** A single tag pick from a check-in/check-out burst. `reader.py:503-505`. */
export interface ScanEvent {
  readonly event: "scan";
  readonly mode: "checkin" | "checkout";
  readonly epc: string;
  readonly reads: number;
  readonly candidates: number;
  readonly rssi: number | undefined;
}

/** A full inventory sweep burst. `reader.py:507-508`. */
export interface InventoryEvent {
  readonly event: "inventory";
  readonly epcs: readonly string[];
  readonly distinct: number;
}

/** First sighting of an EPC within a burst. `reader.py:419-420`. */
export interface LiveEvent {
  readonly event: "live";
  readonly mode: ReaderMode;
  readonly epc: string;
  readonly distinct: number;
}

/** Finder proximity for the target tag. `reader.py:439-440`. */
export interface FinderEvent {
  readonly event: "finder";
  readonly epc: string;
  readonly rssi: number;
  readonly percent: number;
}

/** Trigger release in finder — the UI resets for the next aim. `reader.py:451`. */
export interface FinderResetEvent {
  readonly event: "finder_reset";
}

/** Connection state change. `reader.py:254-264`. */
export interface StatusEvent {
  readonly event: "status";
  readonly connected: boolean;
  readonly message: string;
}

/** Discriminated union of all reader events. */
export type ReaderEvent =
  | ScanEvent
  | InventoryEvent
  | LiveEvent
  | FinderEvent
  | FinderResetEvent
  | StatusEvent;
