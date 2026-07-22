/**
 * The shared Drizzle database type every repository is written against, plus
 * the transaction helper.
 *
 * `DomainDb` is the precise async SQLite database type returned by Drizzle's
 * Turso driver (`drizzle-orm/tursodatabase/database`). Drizzle's
 * `SQLiteAsyncDatabase` is parameterised by a result-kind and a run-result,
 * both of which `TursoDatabaseDatabase` already fixes (`'async'` and
 * `TursoDatabaseRunResult`), so no `any` is needed and no schema generic is
 * required — `db.select().from(table)` is typed from the table, not the db.
 *
 * Repositories use only the builder API and `db.run(sql\`...\`)`, so the same
 * code runs against any Drizzle async SQLite database. The field app (plan 004+)
 * will supply an equivalent database built from the Turso sync Drizzle driver
 * over the on-device Turso client; that wiring is a later plan.
 */

import { sql } from "drizzle-orm";
import type { TursoDatabaseDatabase } from "drizzle-orm/tursodatabase/driver-core";

/** The Drizzle database type every repository function accepts. */
export type DomainDb = TursoDatabaseDatabase;

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
