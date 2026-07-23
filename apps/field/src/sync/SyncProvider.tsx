/**
 * Sync provider (plan 010, Phase 3): builds the single {@link SyncCoordinator}
 * from the opened database + credential store, starts it, wires app-foreground
 * and reconnect triggers (via core RN `AppState`), and exposes the live status
 * to descendants. Also registers the coordinator on the module-level access
 * singleton so the legacy `syncNow()` hook and the unlink/relink flow can drive
 * it without React context.
 *
 * Mounted inside the db-ready gate so the coordinator is built exactly once the
 * raw sync client + Drizzle db + credential store are available.
 */

import { SCHEMA_VERSION } from "@rfid/domain";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { useDbStatus } from "../db/provider";
import { SyncCoordinator } from "./coordinator";
import { TursoSyncEngine } from "./engine";
import { DomainMetaProvider } from "./meta";
import { setCoordinator, setCredentialStore } from "./access";
import type { SyncStatus } from "./status";
import { statusLabel } from "./status";
import { SyncStatusBanner } from "./SyncStatusBanner";

export interface SyncContextValue {
  status: SyncStatus;
  lastSyncedAt: number | null;
  /** Manual "sync now" (immediate cycle). */
  syncNow: () => void;
  /** Escape hatch after re-link/upgrade (clears reauth/blocked). */
  reset: () => void;
}

import { createContext, useContext } from "react";
const SyncContext = createContext<SyncContextValue | null>(null);

/** Access the live sync status + actions. null before the provider mounts. */
export function useSync(): SyncContextValue | null {
  return useContext(SyncContext);
}

export function SyncProvider({ children }: { children: ReactNode }): ReactNode {
  const { db, client, credStore } = useDbStatus();
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const coordRef = useRef<SyncCoordinator | null>(null);

  useEffect(() => {
    if (!db || !client || !credStore) return;
    if (coordRef.current) return; // build once

    const coordinator = new SyncCoordinator({
      engine: new TursoSyncEngine(client, credStore),
      creds: credStore,
      meta: new DomainMetaProvider(db),
      clock: {
        now: () => Date.now(),
        setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
        clearTimeout: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
      },
      supportedSchemaVersion: SCHEMA_VERSION,
      config: {
        debounceMs: 2_000,
        foregroundIntervalMs: 60_000,
        baseMs: 1_000,
        maxBackoffMs: 30_000,
        rand: Math.random,
      },
      callbacks: {
        onStatus: (s, at) => {
          setStatus(s);
          if (s === "synced") setLastSyncedAt(at);
        },
      },
    });
    coordRef.current = coordinator;
    setCoordinator(coordinator);
    setCredentialStore(credStore);
    coordinator.start();

    // App-foreground + reconnect: when the app returns to the foreground,
    // run an immediate cycle (network is typically available again). A
    // dedicated NetInfo listener is a future hardening item.
    const onAppStateChange = (next: AppStateStatus) => {
      if (next === "active") {
        coordinator.onForeground();
        coordinator.onReconnect();
        coordinator.setForegroundActive(true);
      } else {
        coordinator.setForegroundActive(false);
      }
    };
    const sub = AppState.addEventListener("change", onAppStateChange);
    coordinator.setForegroundActive(AppState.currentState === "active");

    return () => {
      sub.remove();
      coordinator.dispose();
      coordRef.current = null;
      setCoordinator(null);
      setCredentialStore(null);
    };
  }, [db, client, credStore]);

  const value: SyncContextValue = {
    status,
    lastSyncedAt,
    syncNow: () => coordRef.current?.trigger("manual"),
    reset: () => coordRef.current?.reset(),
  };

  return (
    <SyncContext.Provider value={value}>
      <SyncStatusBanner status={status} lastSyncedAt={lastSyncedAt} />
      {children}
    </SyncContext.Provider>
  );
}

export { statusLabel };
