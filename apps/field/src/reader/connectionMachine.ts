/**
 * Pure connection-state machine for {@link ReaderService}.
 *
 * The reader service wires native transport events (connect / disconnect /
 * stream-end / heartbeat-stale) into these reducers so the transition logic is
 * decoupled from side effects (timer scheduling, AsyncStorage, AppState) and
 * can be unit-tested without a device or a transport. See
 * `__tests__/connectionMachine.test.ts`.
 */

import type { ReaderMode } from "@rfid/reader-protocol";

/** Connection state: `true` = reader connected, `false` = disconnected. */
export type ConnState = boolean;

/** Events that can drive the connection state machine. */
export type ConnEvent =
  /** Transport reports a live session (initial connect or auto-reconnect). */
  | { readonly type: "connected" }
  /** Transport reports the session is gone (BT off, unpaired, stream end). */
  | { readonly type: "disconnected" }
  /** Heartbeat detected no reader response within the liveness window. */
  | { readonly type: "stale" };

/** Result of a connection transition. */
export interface ConnTransition {
  /** New connected state. */
  readonly connected: ConnState;
  /** Whether the state actually flipped (so callers can skip no-op emits). */
  readonly changed: boolean;
}

/**
 * Reduce a connection event. `disconnected` and `stale` both drop to
 * disconnected; `connected` rises to connected. No-op when the state is
 * already the target, so subscribers aren't flooded with redundant status
 * events.
 */
export function reduceConnection(connected: ConnState, event: ConnEvent): ConnTransition {
  switch (event.type) {
    case "connected":
      return connected
        ? { connected, changed: false }
        : { connected: true, changed: true };
    case "disconnected":
    case "stale":
      return !connected
        ? { connected, changed: false }
        : { connected: false, changed: true };
  }
}

/**
 * Whether the heartbeat loop should be running. Only worth probing a real
 * sled while the native transport is selected, a session is live, and the app
 * is foregrounded — keeps battery cost off the background path and off the
 * simulated transport (which never echoes commands).
 */
export function shouldRunHeartbeat(
  useNative: boolean,
  connected: boolean,
  foreground: boolean,
): boolean {
  return useNative && connected && foreground;
}

/**
 * Whether this heartbeat tick should send a no-op probe command. Probing is
 * only needed when the reader is idle (active modes stream `EP:` lines
 * continuously, which already proves liveness) and enough time has elapsed
 * since the last received data that a probe is due.
 */
export function shouldProbe(
  mode: ReaderMode,
  lastDataAgeMs: number,
  intervalMs: number,
): boolean {
  return mode === "idle" && lastDataAgeMs >= intervalMs;
}

/** Whether the reader has gone silent long enough to declare it stale. */
export function isStale(lastDataAgeMs: number, timeoutMs: number): boolean {
  return lastDataAgeMs >= timeoutMs;
}
