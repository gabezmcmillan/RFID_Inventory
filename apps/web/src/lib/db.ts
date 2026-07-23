/**
 * Web Drizzle database adapter: produces one shared {@link DomainDb} per
 * server process, env-driven.
 *
 * - `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` set -> Drizzle's serverless Turso
 *   driver (`drizzle-orm/tursodatabase-serverless`) over the SQL-over-HTTP
 *   `@tursodatabase/serverless` client. This is the production/Vercel path; the
 *   remote Turso database is migrated out-of-band (plan 010), so this path
 *   applies no migrations.
 * - Otherwise (local dev) -> `drizzle-orm/tursodatabase/database` over a local
 *   file (`LOCAL_DB_PATH`, default `../../.dev-data/web.db`), with all
 *   checked-in migrations applied via the RN-safe `applyMigrations` bundle
 *   runner exported from `@rfid/domain` (no on-disk read, so it survives
 *   Next.js bundling / `import.meta.url` relocation).
 *
 * One shared instance per server process: the promise is memoized on a
 * `globalThis` stash so Next.js dev hot-reload (which re-evaluates modules)
 * reuses the same open database instead of leaking a new file handle per
 * reload. The web app only inserts `requests` rows (multi-writer discipline);
 * it never mutates `tags`.
 *
 * All env reads go through the validated `@/lib/env` module — never raw
 * `process.env`.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { connect } from "@tursodatabase/database";
import { applyMigrations, type DomainDb } from "@rfid/domain";
import { drizzle as drizzleLocal } from "drizzle-orm/tursodatabase/database";
import { drizzle as drizzleServerless } from "drizzle-orm/tursodatabase-serverless";

import { env } from "@/lib/env";

/** Per-process stash so dev hot-reload reuses one open database. */
const GLOBAL = globalThis as unknown as { __rfidWebDbPromise?: Promise<DomainDb> };

/** Default local warehouse-domain dev database path. */
const DEFAULT_LOCAL_DB_PATH = "../../.dev-data/web.db";

/** True when Turso cloud credentials are configured (the production path). */
function hasTursoCloudConfig(): boolean {
  return Boolean(env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN);
}

/** Build a local-file DomainDb and apply all checked-in migrations. */
async function openLocalDb(): Promise<DomainDb> {
  const path = resolve(env.LOCAL_DB_PATH ?? DEFAULT_LOCAL_DB_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const client = await connect(path);
  const db = drizzleLocal({ client });
  await applyMigrations(db);
  return db;
}

/** Build a serverless DomainDb against the Turso cloud database (no migrations). */
function openServerlessDb(): DomainDb {
  const url = env.TURSO_DATABASE_URL!;
  const authToken = env.TURSO_AUTH_TOKEN!;
  // `drizzle()` returns TursoDatabaseServerlessDatabase, which extends
  // SQLiteAsyncDatabase<'async', any> (the serverless Statement.run() is typed
  // `Promise<any>`). `any` is bidirectionally compatible with
  // TursoDatabaseRunResult, so this is assignable to DomainDb without a cast.
  return drizzleServerless({ connection: { url, authToken } });
}

/**
 * Get the shared DomainDb for this server process, opening it on first call.
 * Server components and server actions call this directly; no client-side data
 * fetching library is involved.
 */
export function getDb(): Promise<DomainDb> {
  if (!GLOBAL.__rfidWebDbPromise) {
    GLOBAL.__rfidWebDbPromise = hasTursoCloudConfig()
      ? Promise.resolve(openServerlessDb())
      : openLocalDb();
  }
  return GLOBAL.__rfidWebDbPromise;
}
