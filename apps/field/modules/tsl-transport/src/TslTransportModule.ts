import { NativeModule, requireNativeModule } from "expo";

import type {
  AccessoryInfo,
  OnConnectionChangeEvent,
  OnDataEvent,
} from "./TslTransport.types";

/**
 * A subscription returned by `addListener`; structurally compatible with the
 * native `EventSubscription` (which exposes `remove()`).
 */
export interface TslEventSubscription {
  remove(): void;
}

/**
 * The native `TslTransport` module. Functions are declared on the class so
 * callers get types; the `addListener` overloads type the two events the module
 * emits (`onData`, `onConnectionChange`).
 */
declare class TslTransportModule extends NativeModule<{}> {
  /** List connected MFi accessories with their advertised protocol strings. */
  listAccessories(): AccessoryInfo[];
  /** Open an EASession for the given protocol string; resolves true on success. */
  connect(protocolString: string): Promise<boolean>;
  /** Close the session and stop the stream thread. */
  disconnect(): Promise<void>;
  /** Write a command string to the reader (buffered if the stream is full). */
  send(data: string): Promise<void>;
  /** Subscribe to incoming reader chunks. */
  addListener(
    eventName: "onData",
    listener: (event: OnDataEvent) => void,
  ): TslEventSubscription;
  /** Subscribe to connection state changes. */
  addListener(
    eventName: "onConnectionChange",
    listener: (event: OnConnectionChangeEvent) => void,
  ): TslEventSubscription;
}

export default requireNativeModule<TslTransportModule>("TslTransport");

export type { AccessoryInfo } from "./TslTransport.types";
