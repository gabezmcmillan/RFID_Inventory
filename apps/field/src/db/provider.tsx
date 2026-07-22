/**
 * On-device database provider: opens a local-only Turso sync database, wraps
 * it with Drizzle (RN-safe adapter), applies migrations, seeds the device id,
 * and exposes the resulting {@link DomainDb} via React Context.
 *
 * Sync (plan 010) is intentionally off here — the database is opened with no
 * `url`, so it is local-first only until cloud sync is wired. The Drizzle
 * wrapper (`drizzleTursoRn`) and the migration bundle (`applyMigrations`) are
 * both RN-safe (no Node `fs` / native addon imports).
 */

import { applyMigrations, getMeta, setMeta, type DomainDb } from "@rfid/domain";
import { Database, getDbPath } from "@tursodatabase/sync-react-native";
import { drizzleTursoRn } from "./drizzleTursoRnDriver";

import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

/** The device id seeded into `local_meta` on first run (plan 004). */
const DEFAULT_DEVICE_ID = "01";

interface DbContextValue {
  /** The Drizzle-wrapped on-device database, or `null` until open+migrated. */
  db: DomainDb | null;
  /** `true` while the database is opening / migrating. */
  loading: boolean;
  /** Set if opening or migrating failed. */
  error: Error | null;
}

const DbContext = createContext<DbContextValue | null>(null);

/**
 * Open the on-device database, wrap it with Drizzle, apply migrations, and
 * seed `local_meta.device_id` if absent. Resolves to the ready {@link DomainDb}.
 */
async function openDomainDb(): Promise<DomainDb> {
  const client = new Database({ path: getDbPath("inventory.db") });
  await client.connect();
  const db = drizzleTursoRn(client);
  await applyMigrations(db);
  if (!(await getMeta(db, "device_id"))) {
    await setMeta(db, "device_id", DEFAULT_DEVICE_ID);
  }
  return db;
}

/**
 * App-root provider that opens the on-device database and exposes it. Render a
 * loading screen while `loading` is true; descendants read the db via
 * {@link useDb}.
 */
export function DatabaseProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<DbContextValue>({
    db: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    openDomainDb()
      .then((db) => {
        if (!cancelled) setState({ db, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ db: null, loading: false, error: err instanceof Error ? err : new Error(String(err)) });
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
 * Reactive database status for screens that need to gate on readiness.
 * Prefer {@link useDb} for the db itself once ready.
 */
export function useDbStatus(): DbContextValue {
  const ctx = useContext(DbContext);
  if (!ctx) throw new Error("useDbStatus must be used within a DatabaseProvider");
  return ctx;
}
