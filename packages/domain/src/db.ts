/**
 * The shared Drizzle database type every repository is written against, plus
 * the transaction helper.
 *
 * `DomainDb` is widened to Drizzle's common async SQLite base type
 * {@link SQLiteAsyncDatabase} parameterised by `'async'` and
 * {@link TursoDatabaseRunResult} (the `{ changes, lastInsertRowid }` run
 * result both Turso drivers produce). The Node test/importer path builds a
 * `TursoDatabaseDatabase` (from `drizzle-orm/tursodatabase/database`) and the
 * field app builds an adapter-backed `TursoDatabaseDatabase` over the
 * `@tursodatabase/sync-react-native` client (see
 * `apps/field/src/db/drizzleTursoRnDriver.ts`); both extend this base, so the
 * same repository code runs unchanged against either. No `any` and no schema
 * generic is required — `db.select().from(table)` is typed from the table,
 * not the db, and `.run()` still carries the `{ changes, lastInsertRowid }`
 * metadata the base type guarantees.
 *
 * Repositories use only the builder API and `db.run(sql\`...\`)` / `db.all`
 * / `db.get`, so the same code runs against any Drizzle async SQLite
 * database that shares this run-result shape.
 */

import { sql } from "drizzle-orm";
import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core/async/db";
import type { TursoDatabaseRunResult } from "drizzle-orm/tursodatabase/driver-core";

/** The Drizzle database type every repository function accepts. */
export type DomainDb = SQLiteAsyncDatabase<"async", TursoDatabaseRunResult>;

/**
 * Run `fn` inside a single `BEGIN IMMEDIATE` / `COMMIT` transaction.
 *
 * On any rejection the transaction is rolled back and the error rethrown.
 * Repository functions that perform several writes (checkout drawdown,
 * request fulfillment, admin edits) use this so the row state and the audit
 * event log commit together. Implemented with Drizzle's `db.run(sql\`...\`)` so
 * no raw `SqlDatabase` seam is needed.
 */
export async function withTransaction<T>(
  db: DomainDb,
  fn: () => Promise<T>,
): Promise<T> {
  await db.run(sql`BEGIN IMMEDIATE`);
  try {
    const result = await fn();
    await db.run(sql`COMMIT`);
    return result;
  } catch (err) {
    try {
      await db.run(sql`ROLLBACK`);
    } catch {
      // Swallow rollback errors so the original failure is what surfaces.
    }
    throw err;
  }
}
