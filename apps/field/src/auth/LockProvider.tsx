/**
 * Device-unlock gate provider (plan 010, operator scope addition).
 *
 * Wraps the app and shows a full-screen PIN entry overlay when the device is
 * locked. Drives the pure {@link reduceLock} state machine with the real
 * `AppState` clock and the {@link PinStore} `"device"` slot:
 *
 *  - on launch: lock iff a device PIN is set;
 *  - on background→foreground after {@link DEVICE_PIN_RELOCK_MS}: relock;
 *  - on a correct PIN (entered in the overlay): unlock.
 *
 * The gate is only armed once a device PIN is set during linking (see
 * {@link setDevicePin}); before linking there is no PIN and the app is never
 * locked. Unlinking clears the PIN (see {@link clearDevicePin}). The underlying
 * app stays mounted under the overlay so the sync coordinator and screen state
 * are preserved across lock/unlock.
 */

import { createContext, useContext, useEffect, useReducer, useState, type ReactNode } from "react";
import { AppState, type AppStateStatus, StyleSheet, View } from "react-native";

import { LockScreen } from "./LockScreen";
import { pinStore } from "./pinStoreApp";
import { DEFAULT_RELOCK_AFTER_MS, initialLockState, reduceLock, type LockState } from "./lockState";

/**
 * Relock threshold: relock when the app returns to the foreground after being
 * away for at least this long. 60s avoids relocking on a quick app switch while
 * still relocking an unattended device within a minute.
 */
export const DEVICE_PIN_RELOCK_MS = DEFAULT_RELOCK_AFTER_MS;

export interface LockContextValue {
  locked: boolean;
  hasPin: boolean;
  /** Enter after the overlay's PinEntry verifies a correct PIN. */
  unlock: () => void;
  /** Set the device PIN (called from the link flow); arms the gate. */
  setDevicePin: (pin: string) => Promise<void>;
  /** Clear the device PIN (called on unlink); disarms the gate. */
  clearDevicePin: () => Promise<void>;
}

const LockContext = createContext<LockContextValue | null>(null);

/** Access the device-unlock gate. null before the provider mounts. */
export function useLock(): LockContextValue | null {
  return useContext(LockContext);
}

export function LockProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, dispatch] = useReducer(reduceLock, initialLockState);
  const [ready, setReady] = useState(false);

  // On launch: read whether a device PIN is set and arm the gate accordingly.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const hasPin = await pinStore.hasPin("device");
      if (!cancelled) {
        dispatch({ type: "launch", hasPin });
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Background → record; foreground → maybe relock. `inactive` (a system dialog)
  // is ignored so a permission prompt does not relock the app.
  useEffect(() => {
    const onChange = (next: AppStateStatus): void => {
      const at = Date.now();
      if (next === "active") {
        dispatch({ type: "foreground", at, relockAfterMs: DEVICE_PIN_RELOCK_MS });
      } else if (next === "background") {
        dispatch({ type: "background", at });
      }
    };
    const sub = AppState.addEventListener("change", onChange);
    return () => sub.remove();
  }, []);

  const unlock = (): void => dispatch({ type: "unlocked" });

  const setDevicePin = async (pin: string): Promise<void> => {
    await pinStore.setPin("device", pin);
    dispatch({ type: "pinSet" });
  };

  const clearDevicePin = async (): Promise<void> => {
    await pinStore.clearPin("device");
    dispatch({ type: "pinCleared" });
  };

  const value: LockContextValue = {
    locked: state.locked,
    hasPin: state.hasPin,
    unlock,
    setDevicePin,
    clearDevicePin,
  };

  return (
    <LockContext.Provider value={value}>
      <View style={StyleSheet.absoluteFill}>
        {children}
        {ready && state.locked && state.hasPin ? <LockScreen onUnlock={unlock} /> : null}
      </View>
    </LockContext.Provider>
  );
}

/** Re-export for callers that build the gate. */
export type { LockState };
