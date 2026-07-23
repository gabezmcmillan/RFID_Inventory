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
 *
 * Connection liveness: the native module emits `onConnectionChange` on
 * `EAAccessoryDidConnect`/`DidDisconnect` (BT off/on) and on stream
 * end/error — see {@link connectionMachine.reduceConnection}. As a safety net
 * for cases where the accessory notification doesn't fire (e.g. the sled
 * sleeps without a clean disconnect), a lightweight heartbeat probes the
 * reader while the native transport is connected and the app is foregrounded;
 * missed responses over {@link LIVENESS_TIMEOUT_MS} flip the state to
 * disconnected. The native module re-opens the session automatically when the
 * accessory reappears (it owns `wantsConnection`), so no JS polling is needed.
 */

import {
  ReaderSession,
  type ReaderEvent,
  type ReaderMode,
} from "@rfid/reader-protocol";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, type AppStateStatus } from "react-native";

import { SimulatedReaderTransport } from "./simulatedTransport.js";
import type { ReaderTransport } from "./transport.js";
import {
  isStale,
  reduceConnection,
  shouldProbe,
  shouldRunHeartbeat,
} from "./connectionMachine.js";

/** Tick interval for the quiet-gap finalization check. */
const TICK_INTERVAL_MS = 150;

/** AsyncStorage key for the persisted "use native transport" toggle. */
export const USE_NATIVE_TRANSPORT_KEY = "rfid.field.useNativeTransport";

/** Heartbeat probe interval (seconds between no-op probes while idle). */
const HEARTBEAT_INTERVAL_MS = 8_000;

/**
 * Silence window after which the reader is declared stale (disconnected). With
 * an 8 s probe, this tolerates ~2 missed responses before flipping — fast
 * enough for an operator to see BT-off reflected, slow enough to ride out a
 * momentarily busy reader.
 */
const LIVENESS_TIMEOUT_MS = 20_000;

/** No-op TSL ASCII command (firmware version query) used as a liveness probe. */
const HEARTBEAT_PROBE_CMD = ".ver\r\n";

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
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private appStateSub: { remove(): void } | null = null;
  private transportUnsubs: Array<() => void> = [];
  private _connected = false;
  private _useNative = false;
  private _initialized = false;
  private _foregroundActive = true;
  private _lastDataAtMs = 0;

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
   * Idempotent; safe to call from the app root before any `connect()`. Also
   * wires AppState so the heartbeat only runs while the app is foregrounded.
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    const stored = await AsyncStorage.getItem(USE_NATIVE_TRANSPORT_KEY);
    this._useNative = stored === "true";
    this.transport = await this.createTransport(this._useNative);
    this.wireTransport(this.transport);
    this._lastDataAtMs = Date.now();
    this.setupAppState();
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
    this.stopHeartbeat();
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
    if (this.tickTimer !== null) {
      return;
    }
    this.tickTimer = setInterval(() => this.session.tick(), TICK_INTERVAL_MS);
  }

  /** Stop the tick loop. */
  stopTicking(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private dispatch(event: ReaderEvent): void {
    for (const cb of this.subscribers) {
      cb(event);
    }
  }

  /** Wire the transport's data/connection callbacks to the session. */
  private wireTransport(transport: ReaderTransport): void {
    // Drop any listeners from a previous transport so stale events from an old
    // (disconnected) transport can't flip the state back.
    for (const unsub of this.transportUnsubs) {
      unsub();
    }
    this.transportUnsubs = [];

    this.transportUnsubs.push(
      transport.onData((chunk) => {
        // Any bytes from the reader prove liveness — refresh before feeding
        // the session so a probe response resets the staleness clock.
        this._lastDataAtMs = Date.now();
        this.session.feed(chunk);
      }),
    );
    this.transportUnsubs.push(
      transport.onConnectionChange((connected) => {
        this.handleConnectionEvent(connected ? { type: "connected" } : { type: "disconnected" });
      }),
    );
  }

  /** Apply a connection event through the pure reducer + side effects. */
  private handleConnectionEvent(
    event: { readonly type: "connected" } | { readonly type: "disconnected" } | { readonly type: "stale" },
  ): void {
    const transition = reduceConnection(this._connected, event);
    if (!transition.changed) {
      return;
    }
    this._connected = transition.connected;
    if (transition.connected) {
      this._lastDataAtMs = Date.now();
      this.session.onConnected();
      this.ensureHeartbeat();
    } else {
      // Drop any partial burst and stop the tick loop until reconnect; the
      // heartbeat stops too (nothing to probe while disconnected).
      this.session.onDisconnected();
      this.stopTicking();
      this.stopHeartbeat();
    }
  }

  // -- heartbeat / liveness ---------------------------------------------

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      return;
    }
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private heartbeatTick(): void {
    if (!shouldRunHeartbeat(this._useNative, this._connected, this._foregroundActive)) {
      return;
    }
    const ageMs = Date.now() - this._lastDataAtMs;
    if (isStale(ageMs, LIVENESS_TIMEOUT_MS)) {
      // Reader went silent longer than the liveness window — declare it
      // disconnected. The native module will emit `onConnectionChange` if/when
      // the accessory actually reappears.
      this.handleConnectionEvent({ type: "stale" });
      return;
    }
    if (shouldProbe(this.session.mode, ageMs, HEARTBEAT_INTERVAL_MS)) {
      // No-op probe: a real reader echoes within ~100 ms, refreshing
      // `_lastDataAtMs`. The simulated transport never echoes, so the heartbeat
      // is gated to the native transport via `shouldRunHeartbeat`.
      this.transport?.send(HEARTBEAT_PROBE_CMD);
    }
  }

  // -- app state --------------------------------------------------------

  private setupAppState(): void {
    if (this.appStateSub !== null) {
      return;
    }
    this._foregroundActive = AppState.currentState === "active";
    this.appStateSub = AppState.addEventListener("change", (next: AppStateStatus) => {
      this._foregroundActive = next === "active";
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
