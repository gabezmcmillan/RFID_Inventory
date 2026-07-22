/**
 * JS wrapper adapting the native `TslTransport` External Accessory module to the
 * {@link ReaderTransport} interface. Uses `DEFAULT_PROTOCOL` (`com.uk.tsl.rfid`)
 * when an accessory advertises it, otherwise falls back to the first protocol
 * string the first connected accessory advertises, logging what it found.
 */

import TslTransportModule from "./src/TslTransportModule";
import type { AccessoryInfo } from "./src/TslTransport.types";

import type { ReaderTransport } from "../../src/reader/transport";

/** The protocol string the TSL sled advertises over External Accessory. */
export const DEFAULT_PROTOCOL = "com.uk.tsl.rfid";

/**
 * Pick the protocol string to open: the default if any accessory advertises it,
 * else the first protocol string of the first connected accessory. Returns
 * `null` when no accessory is connected. Logs the choice for diagnostics.
 */
function resolveProtocol(accessories: readonly AccessoryInfo[]): string | null {
  if (accessories.length === 0) {
    console.warn("[tsl-transport] no External Accessory connected");
    return null;
  }
  for (const accessory of accessories) {
    if (accessory.protocolStrings.includes(DEFAULT_PROTOCOL)) {
      console.log(
        `[tsl-transport] using default protocol ${DEFAULT_PROTOCOL} on ${accessory.name}`,
      );
      return DEFAULT_PROTOCOL;
    }
  }
  const first = accessories[0]!;
  const fallback = first.protocolStrings[0];
  if (fallback === undefined) {
    console.warn(`[tsl-transport] ${first.name} advertises no protocol strings`);
    return null;
  }
  console.warn(
    `[tsl-transport] default protocol not found; falling back to ${fallback} on ${first.name}. ` +
      `Advertised: ${first.protocolStrings.join(", ")}`,
  );
  return fallback;
}

/**
 * A {@link ReaderTransport} backed by the native External Accessory session.
 * Verify the protocol string at runtime against `EAAccessoryManager` — a
 * mismatch is a STOP condition (log the actual strings; they are the fix).
 */
export class TslTransport implements ReaderTransport {
  private connected = false;

  async connect(): Promise<void> {
    const accessories = TslTransportModule.listAccessories();
    const protocol = resolveProtocol(accessories);
    if (protocol === null) {
      throw new Error("TSL reader not connected via External Accessory");
    }
    const ok = await TslTransportModule.connect(protocol);
    if (!ok) {
      throw new Error(`Failed to open EASession for protocol ${protocol}`);
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await TslTransportModule.disconnect();
  }

  send(data: string): void {
    // The native module buffers writes when the output stream has no space.
    void TslTransportModule.send(data);
  }

  onData(cb: (chunk: string) => void): () => void {
    const sub = TslTransportModule.addListener("onData", (event) => cb(event.chunk));
    return () => sub.remove();
  }

  onConnectionChange(cb: (connected: boolean) => void): () => void {
    const sub = TslTransportModule.addListener("onConnectionChange", (event) =>
      cb(event.connected),
    );
    return () => sub.remove();
  }

  /** Whether the transport believes it is currently connected. */
  get isConnected(): boolean {
    return this.connected;
  }
}
