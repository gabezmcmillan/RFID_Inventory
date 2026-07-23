/**
 * On-device database provider: opens a local-first Turso sync database, wraps
 * it with Drizzle (RN-safe adapter), applies migrations while sync is OFF, and
 * exposes the resulting {@link DomainDb} plus the raw sync client and the
 * sync credential store via React Context.
 *
 * Plan 010 Phase 3: the database is opened ONCE with function-valued `url` and
 * `authToken` callbacks + `bootstrapIfEmpty`. Sync stays off (url null) until
 * the credential store is primed with a server-minted token + the warehouse
 * URL, so `applyMigrations` runs only while sync is off — never "on the replica
 * in synced mode." The single client is the only opener of `inventory.db`.
 */

import { applyMigrations, type DomainDb } from "@rfid/domain";
import { Database, getDbPath } from "@tursodatabase/sync-react-native";
import { drizzleTursoRn } from "./drizzleTursoRnDriver";
import { SyncCredentialStore } from "../sync/credentialStore";
import { buildBolQueue } from "../sync/bolUpload";

import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

interface DbContextValue {
  /** The Drizzle-wrapped on-device database, or `null` until open+migrated. */
  db: DomainDb | null;
  /** The raw Turso sync client (the sole opener of `inventory.db`), or null. */
  client: Database | null;
  /** The sync credential store (url/authToken callbacks source), or null. */
  credStore: SyncCredentialStore | null;
  /** `true` while the database is opening / migrating. */
  loading: boolean;
  /** Set if opening or migrating failed. */
  error: Error | null;
}

const DbContext = createContext<DbContextValue | null>(null);

/**
 * Open the on-device warehouse database ONCE, wrap it with Drizzle, and apply
 * migrations while sync is still off (url null). The device id and EPC serial
 * counter live in the separate local-only `device.db` (plan 010 Phase 2).
 */
async function openDomainDb(
  credStore: SyncCredentialStore,
): Promise<{ db: DomainDb; client: Database }> {
  const client = new Database({
    path: getDbPath("inventory.db"),
    // Sync switches on only once the credential store is primed (linked +
    // online). Until then url() returns null → local-only.
    url: () => credStore.syncUrl,
    // The Turso `authToken` callback must return a string; when not linked sync
    // is off (url null) so this is never called, but the type requires a string.
    authToken: async () => (await credStore.getSyncToken()) ?? "",
    bootstrapIfEmpty: true,
  });
  await client.connect();
  const db = drizzleTursoRn(client);
  // Runs while sync is off (url null) — never on the replica in synced mode.
  await applyMigrations(db);
  return { db, client };
}

/**
 * App-root provider that opens the on-device database and exposes it. Render a
 * loading screen while `loading` is true; descendants read the db via
 * {@link useDb}.
 */
export function DatabaseProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<DbContextValue>({
    db: null,
    client: null,
    credStore: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    const credStore = new SyncCredentialStore();
    openDomainDb(credStore)
      .then(({ db, client }) => {
        if (!cancelled) {
          setState({ db, client, credStore, loading: false, error: null });
          // Build + restore the BOL upload queue now that the domain db is open.
          // Fire-and-forget: it schedules its own retries and persists to AsyncStorage.
          void buildBolQueue(db);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            db: null,
            client: null,
            credStore: null,
            loading: false,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <DbContext.Provider value={state}>{children}</DbContext.Provider>;
}

/**
 * Access the on-device {@link DomainDb}. Throws if used outside
 * {@link DatabaseProvider}; returns `null` while the database is still opening.
 */
export function useDb(): DomainDb {
  const ctx = useContext(DbContext);
  if (!ctx) throw new Error("useDb must be used within a DatabaseProvider");
  if (ctx.error) throw ctx.error;
  if (ctx.db === null) {
    throw new Error("Database not ready yet — render a loading screen while loading is true");
  }
  return ctx.db;
}

/**
 * Reactive database status for screens that need to gate on readiness, including
 * the raw sync client and credential store for the sync coordinator.
 */
export function useDbStatus(): DbContextValue {
  const ctx = useContext(DbContext);
  if (!ctx) throw new Error("useDbStatus must be used within a DatabaseProvider");
  return ctx;
}
