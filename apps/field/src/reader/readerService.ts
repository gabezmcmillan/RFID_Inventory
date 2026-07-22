/**
 * Reader service — a singleton wiring a {@link ReaderTransport} to a
 * {@link ReaderSession}, exposing the reader API to the rest of the field app.
 *
 * Transport selection: simulated by default, native (External Accessory) when
 * the persisted settings toggle is on. The toggle lives in `AsyncStorage`
 * (key {@link USE_NATIVE_TRANSPORT_KEY}); the settings screen (plan 004) flips
 * it via {@link ReaderService.setUseNativeTransport}. The native transport is
 * loaded with a dynamic import so the simulated default never pulls the native
 * module into the main bundle. The service runs `session.tick()` on a 150 ms
 * interval while a non-idle mode is active, so the 0.6 s quiet-gap finalization
 * fires without hardware.
 */

import {
  ReaderSession,
  type ReaderEvent,
  type ReaderMode,
} from "@rfid/reader-protocol";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { SimulatedReaderTransport } from "./simulatedTransport.js";
import type { ReaderTransport } from "./transport.js";

/** Tick interval for the quiet-gap finalization check. */
const TICK_INTERVAL_MS = 150;

/** AsyncStorage key for the persisted "use native transport" toggle. */
export const USE_NATIVE_TRANSPORT_KEY = "rfid.field.useNativeTransport";

/** Options for {@link ReaderService.setMode}. */
export interface SetModeOptions {
  /** Target EPC for finder mode; ignored otherwise. */
  readonly targetEpc?: string;
}

/** Singleton reader service. */
export class ReaderService {
  private transport: ReaderTransport | null = null;
  private readonly session: ReaderSession;
  private readonly subscribers = new Set<(event: ReaderEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;
  private _useNative = false;
  private _initialized = false;

  constructor() {
    this.session = new ReaderSession({
      send: (cmd) => this.transport?.send(cmd),
      emit: (event) => this.dispatch(event),
      now: () => Date.now() / 1000,
    });
  }

  /** Whether the reader is currently connected. */
  get connected(): boolean {
    return this._connected;
  }

  /** Whether the native External Accessory transport is selected. */
  get useNativeTransport(): boolean {
    return this._useNative;
  }

  /**
   * Load the persisted transport toggle and create the initial transport.
   * Idempotent; safe to call from the app root before any `connect()`.
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    const stored = await AsyncStorage.getItem(USE_NATIVE_TRANSPORT_KEY);
    this._useNative = stored === "true";
    this.transport = await this.createTransport(this._useNative);
    this.wireTransport(this.transport);
    this._initialized = true;
  }

  /**
   * Persist and apply a new transport choice. The old transport is
   * disconnected and replaced; switching to the native sled immediately
   * attempts a connect (errors surface to the caller so the settings screen
   * can show them — the sled may be off or unpaired).
   */
  async setUseNativeTransport(useNative: boolean): Promise<void> {
    await AsyncStorage.setItem(USE_NATIVE_TRANSPORT_KEY, useNative ? "true" : "false");
    if (this._useNative === useNative && this.transport !== null) return;
    await this.disconnect();
    this._useNative = useNative;
    this.transport = await this.createTransport(useNative);
    this.wireTransport(this.transport);
    if (useNative) await this.connect();
  }

  /** Connect the underlying transport (initializing it first if needed). */
  async connect(): Promise<void> {
    await this.init();
    if (this.transport === null) throw new Error("Reader transport not initialized");
    await this.transport.connect();
  }

  /**
   * Init and, when the native sled transport is selected, attempt to connect —
   * swallowing failure (the sled may be off or unpaired at app launch). Called
   * from the app root so a paired sled is live without visiting settings.
   */
  async autoConnect(): Promise<void> {
    await this.init();
    if (!this._useNative) return;
    try {
      await this.connect();
    } catch (err) {
      console.warn("[reader] auto-connect failed:", err);
    }
  }

  /** Disconnect the underlying transport. */
  async disconnect(): Promise<void> {
    this.stopTicking();
    await this.transport?.disconnect();
  }

  /** Switch reader behavior; starts the tick loop for non-idle modes. */
  setMode(mode: ReaderMode, options?: SetModeOptions): void {
    this.session.setMode(mode, options);
    if (mode === "idle") {
      this.stopTicking();
    } else {
      this.ensureTicking();
    }
  }

  /** Set the check-in/check-out output power (dBm); applies live if active. */
  setCheckPower(dbm: number): number {
    return this.session.setCheckPower(dbm);
  }

  /** Request a one-shot handheld alert. */
  alert(): void {
    this.session.alert();
  }

  /** Test hook: finalize a synthetic burst of EPCs without hardware. */
  injectScan(epcs: readonly string[]): void {
    this.session.injectScan(epcs);
  }

  /** Subscribe to reader events; returns an unsubscribe function. */
  subscribe(cb: (event: ReaderEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * The simulated transport's trigger hooks, or `null` when a native transport
   * is in use (or before init). The "simulate scan" button (plan 004+) uses
   * {@link injectScan} instead, which works without a transport.
   */
  get simulated(): SimulatedReaderTransport | null {
    return this.transport instanceof SimulatedReaderTransport ? this.transport : null;
  }

  private ensureTicking(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => this.session.tick(), TICK_INTERVAL_MS);
  }

  /** Stop the tick loop. */
  stopTicking(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private dispatch(event: ReaderEvent): void {
    for (const cb of this.subscribers) {
      cb(event);
    }
  }

  /** Wire the transport's data/connection callbacks to the session. */
  private wireTransport(transport: ReaderTransport): void {
    transport.onData((chunk) => this.session.feed(chunk));
    transport.onConnectionChange((connected) => {
      this._connected = connected;
      if (connected) {
        this.session.onConnected();
      } else {
        this.session.onDisconnected();
      }
    });
  }

  /** Create the transport for the given selection (native is dynamically imported). */
  private async createTransport(useNative: boolean): Promise<ReaderTransport> {
    if (useNative) {
      const { TslTransport } = await import("../../modules/tsl-transport");
      return new TslTransport();
    }
    return new SimulatedReaderTransport();
  }
}

/** The app-wide reader service singleton. */
export const readerService = new ReaderService();
