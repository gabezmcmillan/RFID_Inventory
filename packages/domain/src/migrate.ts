/**
 * Migration runner: applies the drizzle-kit-generated migrations in
 * `packages/domain/drizzle/` to a Drizzle database, in order, using Drizzle's
 * built-in Turso migrator. The migrator records applied migrations in its own
 * journal table (`__drizzle_migrations`), so re-running is idempotent — the
 * test harness and the importer both call this on every open.
 */

import { migrate } from "drizzle-orm/tursodatabase/migrator";
import { fileURLToPath } from "node:url";

import type { DomainDb } from "./db";

/** Absolute path to the generated migrations folder (`packages/domain/drizzle`). */
const migrationsFolder = fileURLToPath(new URL("../drizzle/", import.meta.url));

/** Apply all pending migrations to `db`, in order. Idempotent. */
export async function migrateDb(db: DomainDb): Promise<void> {
  await migrate(db, { migrationsFolder });
}
