/**
 * React-Native-safe migration runner: applies the checked-in
 * {@link MIGRATIONS} bundle to a {@link DomainDb} idempotently, recording
 * each migration into the same `__drizzle_migrations` journal Drizzle's Node
 * Turso migrator uses (same `hash` / `created_at` / `name` columns), so the
 * on-device and Node paths share one journal.
 *
 * Why a separate runner: Drizzle's built-in Turso migrator
 * (`drizzle-orm/tursodatabase/migrator`) reads `.sql` files from disk with
 * Node's `fs`, which React Native cannot do. This runner reads the SQL from the
 * checked-in {@link MIGRATIONS} TS module instead (generated from those same
 * files by `scripts/gen-migrations.ts`), so it runs on-device. The lockstep
 * test in `src/__tests__/migrations.test.ts` guarantees the bundle matches
 * the `.sql` files on disk.
 */

import { sql } from "drizzle-orm";

import type { DomainDb } from "./db.js";
import { withTransaction } from "./db.js";
import { MIGRATIONS } from "./migrations.js";

/** The Drizzle migrations journal table name (matches the Node migrator). */
const JOURNAL_TABLE = "__drizzle_migrations";

/**
 * Apply every pending checked-in migration to `db`, in order. Idempotent: a
 * migration already recorded in `__drizzle_migrations` (by this runner or by
 * the Node migrator) is skipped. Each migration's statements run inside one
 * transaction alongside its journal insert, so a failure leaves no partial
 * migration.
 */
export async function applyMigrations(db: DomainDb): Promise<void> {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS ${sql.identifier(JOURNAL_TABLE)} (
      id INTEGER PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )
  `);

  const applied = await db.all<{ name: string | null }>(
    sql`SELECT name FROM ${sql.identifier(JOURNAL_TABLE)}`,
  );
  const appliedNames = new Set(
    applied.map((row) => row.name).filter((n): n is string => n !== null && n !== ""),
  );

  for (const migration of MIGRATIONS) {
    if (appliedNames.has(migration.name)) continue;
    const statements = migration.sql.split("--> statement-breakpoint");
    await withTransaction(db, async () => {
      for (const stmt of statements) {
        await db.run(sql.raw(stmt));
      }
      await db.run(sql`
        INSERT INTO ${sql.identifier(JOURNAL_TABLE)} ("hash", "created_at", "name", "applied_at")
        VALUES (${migration.hash}, ${migration.folderMillis}, ${migration.name}, ${new Date().toISOString()})
      `);
    });
  }
}
