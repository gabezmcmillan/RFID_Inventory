/**
 * Device-unlock gate state machine (plan 010, operator scope addition).
 *
 * Pure (no React Native, no I/O): a tiny reducer over lock events so the gate's
 * decisions — lock on launch, relock on return-to-foreground after a timeout,
 * unlock on a correct PIN — are fully unit-testable without a device. The
 * {@link LockProvider} drives this with the real `AppState` clock and the
 * {@link PinStore} `"device"` slot.
 *
 * The gate is only active once a device PIN is set (`hasPin`). Before linking
 * there is no PIN and the app is never locked.
 */

export interface LockState {
  /** Whether the app is currently locked behind the PIN entry screen. */
  locked: boolean;
  /** Whether a device PIN hash is stored (gate is armed). */
  hasPin: boolean;
  /** Epoch ms the app last went to the background, or null. */
  lastBackgroundedAt: number | null;
}

export type LockEvent =
  | { type: "launch"; hasPin: boolean }
  | { type: "pinSet" }
  | { type: "pinCleared" }
  | { type: "background"; at: number }
  | { type: "foreground"; at: number; relockAfterMs: number }
  | { type: "unlocked" };

/** The initial state before any event: no PIN, unlocked. */
export const initialLockState: LockState = {
  locked: false,
  hasPin: false,
  lastBackgroundedAt: null,
};

/**
 * Apply a {@link LockEvent} to a {@link LockState}, returning the next state.
 *
 * Semantics:
 *  - `launch`: lock iff a device PIN is set (the gate is armed).
 *  - `pinSet`: arm the gate; the user just authenticated by setting it, so do
 *    not lock them out immediately.
 *  - `pinCleared`: disarm the gate (e.g. on unlink); never locked without a PIN.
 *  - `background`: record when the app left the foreground.
 *  - `foreground`: relock iff a PIN is set and the app was away for at least
 *    `relockAfterMs`. A locked app stays locked.
 *  - `unlocked`: a correct PIN was entered; clear the lock.
 */
export function reduceLock(state: LockState, event: LockEvent): LockState {
  switch (event.type) {
    case "launch":
      return { ...state, hasPin: event.hasPin, locked: event.hasPin, lastBackgroundedAt: null };
    case "pinSet":
      return { ...state, hasPin: true, locked: false };
    case "pinCleared":
      return { ...state, hasPin: false, locked: false, lastBackgroundedAt: null };
    case "background":
      return { ...state, lastBackgroundedAt: event.at };
    case "foreground": {
      if (!state.hasPin) return { ...state, lastBackgroundedAt: null };
      if (state.locked) return { ...state, lastBackgroundedAt: null };
      const away = state.lastBackgroundedAt !== null ? event.at - state.lastBackgroundedAt : 0;
      const relock = state.lastBackgroundedAt !== null && away >= event.relockAfterMs;
      return { ...state, locked: relock, lastBackgroundedAt: null };
    }
    case "unlocked":
      return { ...state, locked: false };
    default:
      return state;
  }
}

/**
 * Default relock threshold: relock when the app returns to the foreground after
 * being away for at least this long. 60s balances "don't relock on a quick app
 * switch" against "don't leave an unattended device unlocked for a shift".
 */
export const DEFAULT_RELOCK_AFTER_MS = 60_000;
