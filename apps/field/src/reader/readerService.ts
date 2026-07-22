/**
 * Reader service — a singleton wiring a {@link ReaderTransport} to a
 * {@link ReaderSession}, exposing the reader API to the rest of the field app.
 *
 * Transport selection: simulated by default in dev, native when available. The
 * native toggle is persisted with `AsyncStorage` in plan 004's settings screen;
 * until then a constant (`USE_NATIVE_TRANSPORT`) selects the transport. The
 * service runs `session.tick()` on a 150 ms interval while a non-idle mode is
 * active, so the 0.6 s quiet-gap finalization fires without hardware.
 */

import {
  ReaderSession,
  type ReaderEvent,
  type ReaderMode,
} from "@rfid/reader-protocol";

import { SimulatedReaderTransport } from "./simulatedTransport.js";
import type { ReaderTransport } from "./transport.js";

/** Tick interval for the quiet-gap finalization check. */
const TICK_INTERVAL_MS = 150;

/**
 * Whether to use the native External Accessory transport. Off until plan 004's
 * settings screen wires a persisted toggle; the simulated transport is the
 * default dev/test rig.
 */
const USE_NATIVE_TRANSPORT = false;

/** Options for {@link ReaderService.setMode}. */
export interface SetModeOptions {
  /** Target EPC for finder mode; ignored otherwise. */
  readonly targetEpc?: string;
}

/** Singleton reader service. */
export class ReaderService {
  private readonly transport: ReaderTransport;
  private readonly session: ReaderSession;
  private readonly subscribers = new Set<(event: ReaderEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;

  constructor() {
    this.transport = this.createTransport();
    this.session = new ReaderSession({
      send: (cmd) => this.transport.send(cmd),
      emit: (event) => this.dispatch(event),
      now: () => Date.now() / 1000,
    });
    this.transport.onData((chunk) => this.session.feed(chunk));
    this.transport.onConnectionChange((connected) => {
      this._connected = connected;
      if (connected) {
        this.session.onConnected();
      } else {
        this.session.onDisconnected();
      }
    });
  }

  /** Whether the reader is currently connected. */
  get connected(): boolean {
    return this._connected;
  }

  /** Connect the underlying transport. */
  async connect(): Promise<void> {
    await this.transport.connect();
  }

  /** Disconnect the underlying transport. */
  async disconnect(): Promise<void> {
    this.stopTicking();
    await this.transport.disconnect();
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
   * is in use. The "simulate scan" button (plan 004+) calls these.
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

  private createTransport(): ReaderTransport {
    if (USE_NATIVE_TRANSPORT) {
      // Plan 004 wires the native External Accessory transport behind a
      // persisted settings toggle. Until then, fall through to simulated.
    }
    return new SimulatedReaderTransport();
  }
}

/** The app-wide reader service singleton. */
export const readerService = new ReaderService();
