/**
 * On-device database provider: opens the warehouse database in one of two modes
 * and exposes the resulting {@link DomainDb} plus the raw client and the sync
 * credential store via React Context.
 *
 * Plan 010 Phase 3 (operator fix): the Turso RN `Database` is opened in exactly
 * one mode at a time, chosen so the native sync engine is never asked to make
 * an HTTP request with no URL:
 *
 * - **`local`** (unlinked, or linked but the credential fetch failed at launch):
 *   `new Database({ path })` with NO sync options at all. The native
 *   `isSyncConfig` check then returns false, so `initLocalDatabase` runs — a
 *   purely local SQLite file, zero sync HTTP attempts, no error banner. This is
 *   the only mode in which `applyMigrations` runs (the plan's rule: never apply
 *   DDL from the phone on the replica in synced mode).
 * - **`synced`** (linked AND a server-minted token + warehouse URL were just
 *   fetched): `new Database({ path, url, authToken, bootstrapIfEmpty })`. The
 *   credential store is primed BEFORE construction so the `url` callback never
 *   returns null at connect time — that null-URL-at-connect case is what crashed
 *   the app at startup ("HTTP request missing URL").
 *
 * The unlinked → linked transition (and linked → unlinked on unlink) reopens
 * the database via {@link DbContextValue.reopen} — the single sanctioned
 * handoff. Only one client ever opens `inventory.db` at a time (the previous
 * client is closed first).
 */

import { applyMigrations, type DomainDb } from "@rfid/domain";
import { Database, getDbPath } from "@tursodatabase/sync-react-native";
import { drizzleTursoRn } from "./drizzleTursoRnDriver";
import { SyncCredentialStore } from "../sync/credentialStore";
import { buildBolQueue } from "../sync/bolUpload";
import { isDeviceLinked } from "../auth/credential";
import { buildDbOpts, resolveEffectiveMode, type DbMode as DbModeType } from "./dbMode";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AppState, type AppStateStatus } from "react-native";

/** How the warehouse DB is opened. See the file header for the contract. */
export type DbMode = DbModeType;

interface DbContextValue {
  /** The Drizzle-wrapped on-device database, or `null` until open+migrated. */
  db: DomainDb | null;
  /** The raw Turso client (the sole opener of `inventory.db`), or null. */
  client: Database | null;
  /** The sync credential store (url/authToken callbacks source), or null. */
  credStore: SyncCredentialStore | null;
  /** The mode the DB was opened in (`local` = no sync engine at all). */
  mode: DbMode;
  /** `true` while the database is opening / migrating / reopening. */
  loading: boolean;
  /** Set if opening or migrating failed. */
  error: Error | null;
  /**
   * Close the current client and reopen in the mode appropriate for the
   * current linked state. Called by the link/unlink flows AFTER they have
   * changed the stored bearer. Resolves once the new client is open.
   */
  reopen: () => Promise<void>;
}

const DbContext = createContext<DbContextValue | null>(null);

/**
 * Open the on-device warehouse database in {@link mode}, wrap it with Drizzle,
 * and (local mode only) apply migrations. The device id and EPC serial counter
 * live in the separate local-only `device.db` (plan 010 Phase 2).
 *
 * In `synced` mode the credential store is primed first so the `url` callback
 * has a non-null warehouse URL at connect time; if that prime fails (offline /
 * server unreachable) the function falls back to `local` so the app still
 * loads — the caller can retry the transition to synced via {@link reopen}.
 */
async function openDomainDb(
  credStore: SyncCredentialStore,
  mode: DbMode,
): Promise<{ db: DomainDb; client: Database; mode: DbMode }> {
  const path = getDbPath("inventory.db");
  let effectiveMode = mode;
  if (mode === "synced") {
    // Prime so credStore.syncUrl is non-null before the sync engine connects.
    try {
      await credStore.ensureReady();
    } catch {
      // Offline / server unreachable at launch → open local for now.
      effectiveMode = "local";
    }
  }
  // Downgrade to local if the URL is unavailable (unlinked or prime failed).
  effectiveMode = resolveEffectiveMode(effectiveMode, credStore.syncUrl !== null);

  const opts = buildDbOpts(path, effectiveMode, credStore);
  const client = new Database(opts);
  await client.connect();
  const db = drizzleTursoRn(client);
  if (effectiveMode === "local") {
    // applyMigrations runs ONLY while sync is off — never on the replica in
    // synced mode (the server bootstraps the schema for an empty replica).
    await applyMigrations(db);
  }
  return { db, client, mode: effectiveMode };
}

/** Pick the initial mode from the current linked state (no cached URL yet). */
async function initialMode(): Promise<DbMode> {
  return (await isDeviceLinked()) ? "synced" : "local";
}

/**
 * App-root provider that opens the on-device database and exposes it. Render a
 * loading screen while `loading` is true; descendants read the db via
 * {@link useDb}.
 */
export function DatabaseProvider({ children }: { children: ReactNode }): ReactNode {
  const credStoreRef = useRef<SyncCredentialStore | null>(null);
  const clientRef = useRef<Database | null>(null);
  const reopeningRef = useRef(false);
  const modeRef = useRef<DbMode>("local");
  const reopenRef = useRef<() => Promise<void>>(async () => {});
  if (credStoreRef.current === null) credStoreRef.current = new SyncCredentialStore();
  const credStore = credStoreRef.current;

  const [state, setState] = useState<DbContextValue>({
    db: null,
    client: null,
    credStore,
    mode: "local",
    loading: true,
    error: null,
    reopen: async () => {
      await reopenRef.current();
    },
  });

  /** Close the current client and reopen for the current linked state. */
  const reopen = async (): Promise<void> => {
    if (reopeningRef.current) return;
    reopeningRef.current = true;
    try {
      const mode = await initialMode();
      const { db, client, mode: openedMode } = await openDomainDb(credStore, mode);
      clientRef.current?.close();
      clientRef.current = client;
      modeRef.current = openedMode;
      setState((prev) => ({
        ...prev,
        db,
        client,
        mode: openedMode,
        loading: false,
        error: null,
      }));
      void buildBolQueue(db);
    } catch (err: unknown) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err : new Error(String(err)),
      }));
    } finally {
      reopeningRef.current = false;
    }
  };
  reopenRef.current = reopen;

  useEffect(() => {
    let cancelled = false;
    initialMode()
      .then((mode) => openDomainDb(credStore, mode))
      .then(({ db, client, mode }) => {
        if (cancelled) {
          client.close();
          return;
        }
        clientRef.current = client;
        modeRef.current = mode;
        setState((prev) => ({
          ...prev,
          db,
          client,
          mode,
          loading: false,
          error: null,
        }));
        void buildBolQueue(db);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            db: null,
            client: null,
            mode: "local",
            loading: false,
            error: err instanceof Error ? err : new Error(String(err)),
          }));
        }
      });

    // Linked-but-offline-at-launch: the DB opened local even though a device
    // is linked. On each return to the foreground, attempt the synced reopen
    // (it primes the credential store inside; no-op if already synced).
    const onAppStateChange = (next: AppStateStatus): void => {
      if (next !== "active") return;
      if (modeRef.current !== "local") return;
      void (async (): Promise<void> => {
        if (!(await isDeviceLinked())) return;
        await reopen();
      })();
    };
    const sub = AppState.addEventListener("change", onAppStateChange);

    return () => {
      cancelled = true;
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
 * the raw sync client, the credential store, the open mode, and the
 * {@link DbContextValue.reopen reopen} handoff for the link/unlink flows.
 */
export function useDbStatus(): DbContextValue {
  const ctx = useContext(DbContext);
  if (!ctx) throw new Error("useDbStatus must be used within a DatabaseProvider");
  return ctx;
}
