/**
 * Minimal SQL surface that every repository is written against.
 *
 * The same `SqlDatabase` shape is satisfied by the Node Turso engine
 * (`@tursodatabase/database`, used in tests and by the importer) and by the
 * on-device Turso React Native driver (plan 004+), so repository code written
 * against it runs unchanged in all three places.
 */

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqlDatabase {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Run `fn` inside a single `BEGIN IMMEDIATE` / `COMMIT` transaction.
 *
 * On any rejection the transaction is rolled back and the error rethrown.
 * Repository functions that perform several writes (checkout drawdown,
 * request fulfillment, admin edits) use this so the row state and the audit
 * event log commit together.
 */
export async function withTransaction<T>(
  db: SqlDatabase,
  fn: () => Promise<T>,
): Promise<T> {
  await db.exec("BEGIN IMMEDIATE");
  try {
    const result = await fn();
    await db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      await db.exec("ROLLBACK");
    } catch {
      // Swallow rollback errors so the original failure is what surfaces.
    }
    throw err;
  }
}
