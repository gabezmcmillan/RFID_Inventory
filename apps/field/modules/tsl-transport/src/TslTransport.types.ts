/**
 * Types exported by the native TSL transport module.
 */

/** A connected MFi accessory as reported by `EAAccessoryManager`. */
export interface AccessoryInfo {
  /** Human-readable accessory name. */
  readonly name: string;
  /** Protocol strings the accessory advertises (e.g. `com.uk.tsl.rfid`). */
  readonly protocolStrings: readonly string[];
}

/** Event payload for `onData`: a UTF-8 chunk from the reader. */
export interface OnDataEvent {
  readonly chunk: string;
}

/** Event payload for `onConnectionChange`. */
export interface OnConnectionChangeEvent {
  readonly connected: boolean;
}
