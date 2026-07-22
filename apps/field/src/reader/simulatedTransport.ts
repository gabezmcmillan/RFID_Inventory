/**
 * {@link SimulatedReaderTransport} — a pure-TypeScript {@link ReaderTransport}
 * that fakes the TSL sled for development and tests. Exposes trigger hooks the
 * "simulate scan" button (plan 004+) drives; emits realistic `EP:`/`RI:`/`OK:`
 * and `SW:off` line sequences through `onData`.
 */

import type { ReaderTransport } from "./transport.js";

/**
 * A simulated reader transport. Connects instantly; `send` is a no-op (the
 * simulated reader doesn't echo commands). Use {@link simulateTriggerPull}
 * and {@link simulateTriggerRelease} to mimic the physical trigger.
 */
export class SimulatedReaderTransport implements ReaderTransport {
  private readonly dataCbs = new Set<(chunk: string) => void>();
  private readonly connCbs = new Set<(connected: boolean) => void>();
  private _connected = false;

  async connect(): Promise<void> {
    this._connected = true;
    this._emitConnection(true);
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this._emitConnection(false);
  }

  /** The simulated reader accepts commands silently. */
  send(_data: string): void {
    // Intentionally empty: the simulated sled doesn't echo.
  }

  onData(cb: (chunk: string) => void): () => void {
    this.dataCbs.add(cb);
    return () => {
      this.dataCbs.delete(cb);
    };
  }

  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connCbs.add(cb);
    return () => {
      this.connCbs.delete(cb);
    };
  }

  /** Whether the simulated transport is currently connected. */
  get connected(): boolean {
    return this._connected;
  }

  /**
   * Mimic pulling the trigger: stream `EP:`/`RI:` lines for the given EPCs,
   * then an `OK:` to end the `.iv` cycle. `rssi` optionally maps an EPC to a
   * dBm value for its `RI:` line.
   */
  simulateTriggerPull(epcs: readonly string[], rssi?: Readonly<Record<string, number>>): void {
    for (const epc of epcs) {
      this._emit(`EP:${epc}\r\n`);
      const r = rssi?.[epc];
      if (r !== undefined) {
        this._emit(`RI:${r}\r\n`);
      }
    }
    this._emit("OK:\r\n");
  }

  /** Mimic releasing the trigger. */
  simulateTriggerRelease(): void {
    this._emit("SW:off\r\n");
  }

  private _emit(chunk: string): void {
    for (const cb of this.dataCbs) {
      cb(chunk);
    }
  }

  private _emitConnection(connected: boolean): void {
    for (const cb of this.connCbs) {
      cb(connected);
    }
  }
}
