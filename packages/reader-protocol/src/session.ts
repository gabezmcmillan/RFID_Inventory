/**
 * {@link ReaderSession} — a behavioral port of `apps/warehouse/reader.py`'s
 * `ReaderWorker` state machine, minus threads and serial I/O.
 *
 * The session owns burst accumulation, the 0.6 s quiet-gap finalization, the
 * single-mode strongest-peak-RSSI tag pick, live events, finder RSSI→percent
 * mapping and reset, and the mode-change side-effect command sequences. All
 * hardware interaction is injected: `send` writes a command string to the
 * reader, `emit` delivers a {@link ReaderEvent} to the host, and `now` (default
 * `Date.now()/1000`, seconds) is injectable so tests can drive the quiet gap
 * deterministically. Single-threaded, so no locks are needed (the Python worker
 * uses a lock around shared state; here every mutation is synchronous).
 */

import {
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
import { classifyLine, LineTokenizer } from "./lines.js";
import type { ReaderEvent, ReaderMode } from "./events.js";

/** Constructor dependencies for a {@link ReaderSession}. */
export interface ReaderSessionDeps {
  /** Write a command string (including `\r\n`) to the reader. */
  readonly send: (cmd: string) => void;
  /** Deliver a reader event to the host. */
  readonly emit: (event: ReaderEvent) => void;
  /** Monotonic clock in seconds. Defaults to wall-clock seconds. */
  readonly now?: () => number;
}

/** Modes that pick one tag per trigger pull. `reader.py:SINGLE_MODES`. */
const SINGLE_MODES: ReadonlySet<ReaderMode> = new Set(["checkin", "checkout"]);

/** Modes that sweep every distinct tag. `reader.py:SWEEP_MODES`. */
const SWEEP_MODES: ReadonlySet<ReaderMode> = new Set(["inventory"]);

/** Options for {@link ReaderSession.setMode}. */
export interface SetModeOptions {
  /** Target EPC for finder mode; ignored otherwise. */
  readonly targetEpc?: string;
}

/**
 * Output power (dBm) for a mode, or `null` to leave the reader unchanged.
 * `reader.py:_power_for_mode`.
 */
function powerForMode(mode: ReaderMode, checkPower: number): number | null {
  if (mode === "checkin" || mode === "checkout") {
    return checkPower;
  }
  if (mode === "inventory" || mode === "finder") {
    return INVENTORY_POWER;
  }
  return null;
}

/** Per-EPC burst accumulator. */
interface Burst {
  counts: Map<string, number>;
  distinct: Set<string>;
  rssiPeak: Map<string, number>;
  lastRead: number;
}

function emptyBurst(): Burst {
  return { counts: new Map(), distinct: new Set(), rssiPeak: new Map(), lastRead: 0 };
}

/**
 * Choose one EPC from a burst: strongest peak RSSI wins (read count breaks
 * ties); fall back to the most-read EPC when no RSSI was captured.
 * `reader.py:_pick_epc`.
 */
function pickEpc(counts: Map<string, number>, rssiPeak: Map<string, number>): string {
  if (rssiPeak.size > 0) {
    let best = "";
    let bestKey = -Infinity;
    let bestCount = -1;
    for (const epc of rssiPeak.keys()) {
      const rssi = rssiPeak.get(epc) ?? -Infinity;
      const count = counts.get(epc) ?? 0;
      if (rssi > bestKey || (rssi === bestKey && count > bestCount)) {
        best = epc;
        bestKey = rssi;
        bestCount = count;
      }
    }
    return best;
  }
  let mostRead = "";
  let max = -1;
  for (const [epc, count] of counts) {
    if (count > max) {
      mostRead = epc;
      max = count;
    }
  }
  return mostRead;
}

/** The reader protocol state machine. */
export class ReaderSession {
  private readonly _send: (cmd: string) => void;
  private readonly _emit: (event: ReaderEvent) => void;
  private readonly _now: () => number;
  private readonly _tokenizer = new LineTokenizer();

  private _mode: ReaderMode = "idle";
  private _checkPower = CHECK_POWER_DEFAULT;
  private _finderTarget: string | null = null;
  private _lastEpc: string | null = null;

  // Pending/applied state mirrors reader.py's _pending_*/_applied_* fields.
  private _pendingPower: number | null = null;
  private _appliedPower: number | null = null;
  private _pendingRssi: boolean | null = null;
  private _appliedRssi: boolean | null = null;
  private _pendingBeep: boolean | null = null;
  private _appliedBeep: boolean | null = null;
  private _pendingFinder = false;
  private _appliedFinder: string | null = null;
  private _pendingAlert = false;

  private _burst: Burst = emptyBurst();

  constructor(deps: ReaderSessionDeps) {
    this._send = deps.send;
    this._emit = deps.emit;
    this._now = deps.now ?? (() => Date.now() / 1000);
  }

  /** Current mode. */
  get mode(): ReaderMode {
    return this._mode;
  }

  /** Current check-in/check-out power (dBm). */
  get checkPower(): number {
    return this._checkPower;
  }

  /**
   * Switch reader behavior (power / RSSI / beep / finder mask). `targetEpc`
   * only matters for finder. Drops any partially accumulated burst.
   * `reader.py:set_mode`.
   */
  setMode(mode: ReaderMode, options?: SetModeOptions): void {
    this._mode = mode;
    this._finderTarget = mode === "finder" ? (options?.targetEpc ?? null) : null;
    this._lastEpc = null;
    this._burst = emptyBurst();
    const power = powerForMode(mode, this._checkPower);
    if (power !== null) {
      this._pendingPower = power;
    }
    this._pendingRssi = mode === "checkin" || mode === "checkout" || mode === "finder";
    this._pendingBeep = mode !== "finder";
    this._pendingFinder = true;
    this._applyPending();
  }

  /** Set the check-in/check-out output power (dBm); applies live if active. `reader.py:set_check_power`. */
  setCheckPower(dbm: number): number {
    const clamped = clampPower(dbm);
    this._checkPower = Math.max(POWER_MIN, Math.min(POWER_MAX, clamped));
    if (this._mode === "checkin" || this._mode === "checkout") {
      this._pendingPower = this._checkPower;
      this._applyPower();
    }
    return this._checkPower;
  }

  /** Request a one-shot handheld alert (buzz/vibrate). `reader.py:alert`. */
  alert(): void {
    this._pendingAlert = true;
    this._applyAlert();
  }

  /**
   * Call on (re)connect: send `.sa -aon`, reset applied state so every
   * parameter is re-applied (the reader resets on power-up), and emit a
   * `status` event. `reader.py:_run` connect path.
   */
  onConnected(): void {
    this._send(switchNotifications());
    this._appliedPower = null;
    this._appliedRssi = null;
    this._appliedBeep = null;
    this._appliedFinder = null;
    const power = powerForMode(this._mode, this._checkPower);
    if (power !== null) {
      this._pendingPower = power;
    }
    this._pendingRssi =
      this._mode === "checkin" || this._mode === "checkout" || this._mode === "finder";
    this._pendingBeep = this._mode !== "finder";
    this._pendingFinder = true;
    this._applyPending();
    this._emit({ event: "status", connected: true, message: "Reader connected" });
  }

  /** Report a disconnect. */
  onDisconnected(message = "Reader disconnected"): void {
    this._emit({ event: "status", connected: false, message });
  }

  /**
   * Feed a raw chunk from the transport: line-split, classify, and handle each
   * complete line. `reader.py:_read_loop` + `_handle_line`.
   */
  feed(chunk: string): void {
    const lines = this._tokenizer.push(chunk);
    for (const raw of lines) {
      if (raw === "") {
        continue;
      }
      const line = classifyLine(raw);
      if (line === null) {
        continue;
      }
      this._handleLine(line);
    }
  }

  /**
   * Quiet-gap check: finalize the burst if no `EP:`/`OK:` activity for
   * {@link QUIET_GAP_SECONDS}. Callers invoke this on an interval or after each
   * feed. `reader.py:_maybe_finalize`.
   */
  tick(): void {
    if (this._burst.distinct.size === 0) {
      return;
    }
    if (this._now() - this._burst.lastRead < QUIET_GAP_SECONDS) {
      return;
    }
    const burst = this._burst;
    this._burst = emptyBurst();
    this._finalize(this._mode, burst);
  }

  /**
   * Test hook: finalize a synthetic burst of EPCs as if the reader produced
   * them. No hardware required. `reader.py:inject_scan`.
   */
  injectScan(epcs: readonly string[]): void {
    if (this._mode === "idle") {
      return;
    }
    const counts = new Map<string, number>();
    const distinct = new Set<string>();
    for (const epc of epcs) {
      const up = epc.toUpperCase();
      distinct.add(up);
      counts.set(up, (counts.get(up) ?? 0) + 1);
    }
    this._finalize(this._mode, { counts, distinct, rssiPeak: new Map(), lastRead: 0 });
  }

  // -- line handling -------------------------------------------------------

  private _handleLine(
    line:
      | { readonly kind: "ep"; readonly epc: string }
      | { readonly kind: "ri"; readonly rssi: number }
      | { readonly kind: "sw"; readonly state: string }
      | { readonly kind: "ok" }
      | { readonly kind: "er" }
      | { readonly kind: "other"; readonly raw: string },
  ): void {
    switch (line.kind) {
      case "ep":
        this._onEp(line.epc);
        break;
      case "ri":
        this._onRi(line.rssi);
        break;
      case "sw":
        this._onSw(line.state);
        break;
      case "ok":
      case "er":
        this._onEnd();
        break;
      default:
        break;
    }
  }

  private _onEp(epc: string): void {
    this._lastEpc = epc;
    if (this._mode === "idle" || this._mode === "finder") {
      // Finder streams RSSI, not tag accumulation; idle ignores reads.
      return;
    }
    this._burst.lastRead = this._now();
    const isNew = !this._burst.distinct.has(epc);
    this._burst.counts.set(epc, (this._burst.counts.get(epc) ?? 0) + 1);
    this._burst.distinct.add(epc);
    if (isNew) {
      this._emit({
        event: "live",
        mode: this._mode,
        epc,
        distinct: this._burst.distinct.size,
      });
    }
  }

  private _onRi(rssi: number): void {
    const last = this._lastEpc;
    if ((this._mode === "checkin" || this._mode === "checkout") && last !== null) {
      const prev = this._burst.rssiPeak.get(last);
      if (prev === undefined || rssi > prev) {
        this._burst.rssiPeak.set(last, rssi);
      }
      return;
    }
    if (this._mode === "finder" && last !== null && last === this._finderTarget) {
      const span = FINDER_RSSI_MAX_DBM - FINDER_RSSI_MIN_DBM;
      let percent = Math.round(((rssi - FINDER_RSSI_MIN_DBM) / span) * 100);
      percent = Math.max(0, Math.min(100, percent));
      this._emit({ event: "finder", epc: last, rssi, percent });
    }
  }

  private _onSw(state: string): void {
    if (state === "off") {
      this._lastEpc = null;
      if (this._mode === "finder") {
        this._emit({ event: "finder_reset" });
      }
    }
  }

  private _onEnd(): void {
    this._lastEpc = null;
    if (this._burst.distinct.size > 0) {
      this._burst.lastRead = this._now();
    }
  }

  // -- finalization --------------------------------------------------------

  private _finalize(mode: ReaderMode, burst: Burst): void {
    if (mode === "idle" || burst.distinct.size === 0) {
      return;
    }
    if (SINGLE_MODES.has(mode)) {
      const epc = pickEpc(burst.counts, burst.rssiPeak);
      this._emit({
        event: "scan",
        mode: mode as "checkin" | "checkout",
        epc,
        reads: burst.counts.get(epc) ?? 0,
        candidates: burst.distinct.size,
        rssi: burst.rssiPeak.get(epc),
      });
      return;
    }
    if (SWEEP_MODES.has(mode)) {
      this._emit({
        event: "inventory",
        epcs: [...burst.distinct].sort(),
        distinct: burst.distinct.size,
      });
    }
  }

  // -- pending-state application (reader.py:_apply_pending_*) --------------

  private _applyPending(): void {
    this._applyPower();
    this._applyRssi();
    this._applyBeep();
    this._applyFinder();
    this._applyAlert();
  }

  private _applyPower(): void {
    const power = this._pendingPower;
    this._pendingPower = null;
    if (power === null || power === this._appliedPower) {
      return;
    }
    this._send(setPower(power));
    this._appliedPower = power;
  }

  private _applyRssi(): void {
    const want = this._pendingRssi;
    this._pendingRssi = null;
    if (want === null || want === this._appliedRssi) {
      return;
    }
    this._send(setRssiOutput(want));
    this._appliedRssi = want;
  }

  private _applyBeep(): void {
    const want = this._pendingBeep;
    this._pendingBeep = null;
    if (want === null || want === this._appliedBeep) {
      return;
    }
    this._send(setBeep(want));
    this._appliedBeep = want;
  }

  private _applyFinder(): void {
    const pending = this._pendingFinder;
    this._pendingFinder = false;
    const want = this._mode === "finder" ? this._finderTarget : null;
    if (!pending || want === this._appliedFinder) {
      return;
    }
    if (want !== null) {
      this._send(finderMask(want));
    } else {
      this._send(finderRestore());
    }
    this._appliedFinder = want;
  }

  private _applyAlert(): void {
    const want = this._pendingAlert;
    this._pendingAlert = false;
    if (!want) {
      return;
    }
    this._send(alertFire());
    this._send(alertRestore());
  }
}
