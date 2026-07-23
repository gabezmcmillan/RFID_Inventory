/**
 * Sync coordinator — one serialized push+pull state machine (plan 010,
 * Phase 3).
 *
 * Pure: it owns NO timers and NO network. A `Clock` provides `now`/`setTimeout`/
 * `clearTimeout` (production wires `globalThis`; tests inject fake timers), an
 * injected `SyncEngine` performs `push`/`pull`, a `CredentialProvider` refreshes
 * the short-lived sync token, and a `MetaProvider` reads the synced server
 * schema version. This keeps every trigger, retry, and auth transition
 * deterministic and unit-testable without a device.
 *
 * Triggers (all funnel through one serialized cycle):
 *  - startup        — first cycle after readiness
 *  - manual         — explicit "sync now"
 *  - mutation       — debounced; coalesces a burst of local writes into one cycle
 *  - foreground     — app returned to the foreground
 *  - reconnect      — network came back
 *  - timer          — internal backoff / foreground tick
 *
 * Failure handling:
 *  - transient failure → `retrying` with jittered exponential backoff, capped.
 *  - 401/403 (AuthError) → refresh the sync token ONCE and retry the step; if it
 *    fails again (refresh threw AuthError, or the retried step still 401/403) →
 *    `reauth` and STOP (no infinite retry). The device must re-link or upgrade.
 *  - server schema ahead of this build → `blocked`; writes held until upgrade.
 */

import { nextBackoffMs } from "./backoff";
import { AuthError, isAuthError, isTransientError } from "./errors";
import { checkSchemaVersion } from "./schemaVersion";
import type { SyncStatus } from "./status";

export type Trigger = "startup" | "manual" | "mutation" | "foreground" | "reconnect" | "timer";

/** Performs the actual push/pull against the Turso embedded replica. */
export interface SyncEngine {
  push(): Promise<void>;
  /** @returns whether the pull applied remote changes. */
  pull(): Promise<boolean>;
}

/** Refreshes the short-lived server-minted sync token. Throws AuthError when
 *  the device is revoked / the bearer is no longer valid. */
export interface CredentialProvider {
  refreshSyncToken(): Promise<void>;
}

/** Reads the synced server schema version (a meta row), or null when unknown. */
export interface MetaProvider {
  getRemoteSchemaVersion(): Promise<number | null>;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface CoordinatorConfig {
  /** Debounce window for coalescing a burst of mutations into one cycle. */
  debounceMs: number;
  /** Periodic foreground tick interval. */
  foregroundIntervalMs: number;
  /** Backoff base unit (ms). */
  baseMs: number;
  /** Backoff cap (ms). */
  maxBackoffMs: number;
  /** PRNG for jitter (tests inject a deterministic one). */
  rand: () => number;
}

export interface CoordinatorCallbacks {
  onStatus?: (status: SyncStatus, at: number) => void;
}

const DEFAULT_CONFIG: CoordinatorConfig = {
  debounceMs: 2_000,
  foregroundIntervalMs: 60_000,
  baseMs: 1_000,
  maxBackoffMs: 30_000,
  rand: Math.random,
};

export class SyncCoordinator {
  private _status: SyncStatus = "idle";
  private _running = false;
  private _pendingTrigger: Trigger | null = null;
  private _attempt = 0;
  private _retriedAuth = false;
  private _lastSyncedAt: number | null = null;

  private _debounceTimer: number | null = null;
  private _retryTimer: number | null = null;
  private _foregroundTimer: number | null = null;
  private _foregroundActive = false;

  private readonly _engine: SyncEngine;
  private readonly _creds: CredentialProvider;
  private readonly _meta: MetaProvider;
  private readonly _clock: Clock;
  private readonly _cfg: CoordinatorConfig;
  private readonly _supportedSchema: number;
  private readonly _cb: CoordinatorCallbacks;

  constructor(deps: {
    engine: SyncEngine;
    creds: CredentialProvider;
    meta: MetaProvider;
    clock: Clock;
    supportedSchemaVersion: number;
    config?: Partial<CoordinatorConfig>;
    callbacks?: CoordinatorCallbacks;
  }) {
    this._engine = deps.engine;
    this._creds = deps.creds;
    this._meta = deps.meta;
    this._clock = deps.clock;
    this._supportedSchema = deps.supportedSchemaVersion;
    this._cfg = { ...DEFAULT_CONFIG, ...deps.config };
    this._cb = deps.callbacks ?? {};
  }

  get status(): SyncStatus {
    return this._status;
  }

  get lastSyncedAt(): number | null {
    return this._lastSyncedAt;
  }

  /** Kick the first cycle (startup). Safe to call once. */
  start(): void {
    this.trigger("startup");
  }

  /** Funnel every trigger through one serialized cycle. */
  trigger(type: Trigger): void {
    // Terminal states: re-link/upgrade required stops all automatic retry.
    if (this._status === "reauth" || this._status === "blocked") {
      // A manual trigger after the operator re-linked/upgrade is the only way
      // out; `reset()` is the explicit escape hatch (see unlink/relink wiring).
      return;
    }
    if (type === "mutation") {
      this._scheduleDebounced();
      return;
    }
    this._scheduleCycle(type);
  }

  /** Called by the app when it returns to the foreground. */
  onForeground(): void {
    this.trigger("foreground");
  }

  /** Called when the network comes back. */
  onReconnect(): void {
    this.trigger("reconnect");
  }

  /** Start/stop the periodic foreground tick. The app toggles this on
   *  AppState active/background. */
  setForegroundActive(active: boolean): void {
    this._foregroundActive = active;
    if (active) {
      this._scheduleForegroundTick();
    } else if (this._foregroundTimer !== null) {
      this._clock.clearTimeout(this._foregroundTimer);
      this._foregroundTimer = null;
    }
  }

  /** Explicit escape hatch after the operator re-links a device or upgrades
   *  the app. Clears the terminal state and runs one cycle. */
  reset(): void {
    if (this._retryTimer !== null) {
      this._clock.clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._attempt = 0;
    this._retriedAuth = false;
    this._setStatus("idle");
    this._scheduleCycle("manual");
  }

  dispose(): void {
    for (const id of [this._debounceTimer, this._retryTimer, this._foregroundTimer]) {
      if (id !== null) this._clock.clearTimeout(id);
    }
    this._debounceTimer = this._retryTimer = this._foregroundTimer = null;
  }

  // ---- internals -----------------------------------------------------------

  private _scheduleDebounced(): void {
    if (this._debounceTimer !== null) this._clock.clearTimeout(this._debounceTimer);
    this._debounceTimer = this._clock.setTimeout(() => {
      this._debounceTimer = null;
      this._scheduleCycle("mutation");
    }, this._cfg.debounceMs);
    if (this._status === "idle" || this._status === "synced") this._setStatus("pending");
  }

  private _scheduleForegroundTick(): void {
    if (!this._foregroundActive) return;
    if (this._foregroundTimer !== null) this._clock.clearTimeout(this._foregroundTimer);
    this._foregroundTimer = this._clock.setTimeout(() => {
      this._foregroundTimer = null;
      this.trigger("foreground");
      this._scheduleForegroundTick();
    }, this._cfg.foregroundIntervalMs);
  }

  private _scheduleCycle(_trigger: Trigger): void {
    if (this._running) {
      // Coalesce: remember that another cycle is wanted after the current one.
      this._pendingTrigger = _trigger;
      return;
    }
    void this._runCycle();
  }

  private async _runCycle(): Promise<void> {
    this._running = true;
    try {
      // 1. Schema gate before any write.
      const remote = await this._meta.getRemoteSchemaVersion();
      const check = checkSchemaVersion(this._supportedSchema, remote);
      if (!check.ok) {
        this._setStatus("blocked");
        this._attempt = 0;
        return;
      }

      // 2. Push (writes), then pull.
      const step = async (): Promise<boolean> => {
        await this._runStep(() => this._engine.push());
        return this._runStep(() => this._engine.pull());
      };

      const changed = await step();

      // 3. Success.
      this._attempt = 0;
      this._retriedAuth = false;
      this._lastSyncedAt = this._clock.now();
      this._setStatus(changed ? "synced" : "synced");
    } catch (e) {
      if (isAuthError(e)) {
        // Refresh already attempted inside _runStep and still failed → reauth.
        this._setStatus("reauth");
        this._attempt = 0;
        this._retriedAuth = false;
        return;
      }
      // Transient (or unknown) → backoff retry.
      this._setStatus("retrying");
      this._scheduleRetry();
      return;
    } finally {
      this._running = false;
    }

    // 4. Drain a coalesced trigger.
    if (this._pendingTrigger !== null) {
      const next = this._pendingTrigger;
      this._pendingTrigger = null;
      this._scheduleCycle(next);
    }
  }

  /**
   * Run one push/pull step with single-refresh auth handling. Throws AuthError
   * (to be caught by the cycle) when the token is still invalid after one
   * refresh; throws the original transient error otherwise.
   */
  private async _runStep<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!isAuthError(e)) throw e;
      // 401/403: refresh the sync token once and retry the step.
      if (this._retriedAuth) {
        // Already retried this cycle → stop. Caller's catch → reauth.
        throw e;
      }
      this._retriedAuth = true;
      await this._creds.refreshSyncToken(); // throws AuthError if revoked
      return fn(); // retry the SAME step once
    }
  }

  private _scheduleRetry(): void {
    const delay = nextBackoffMs(this._attempt, {
      baseMs: this._cfg.baseMs,
      maxMs: this._cfg.maxBackoffMs,
      rand: this._cfg.rand,
    });
    this._attempt += 1;
    if (this._retryTimer !== null) this._clock.clearTimeout(this._retryTimer);
    this._retryTimer = this._clock.setTimeout(() => {
      this._retryTimer = null;
      this.trigger("timer");
    }, delay);
  }

  private _setStatus(status: SyncStatus): void {
    this._status = status;
    this._cb.onStatus?.(status, this._clock.now());
  }
}

/** Re-export for callers that build a coordinator. */
export { isTransientError };
