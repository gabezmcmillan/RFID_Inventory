import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { connect } from "@tursodatabase/database";
import { describe, expect, test } from "vitest";

import { applyMigrations } from "../applyMigrations.js";
import { MIGRATIONS } from "../migrations.js";
import { wrapTurso } from "../testing/openTestDb.js";

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, "..", "..", "drizzle");

function formatToMillis(dateStr: string): number {
  const year = Number.parseInt(dateStr.slice(0, 4), 10);
  const month = Number.parseInt(dateStr.slice(4, 6), 10) - 1;
  const day = Number.parseInt(dateStr.slice(6, 8), 10);
  const hour = Number.parseInt(dateStr.slice(8, 10), 10);
  const minute = Number.parseInt(dateStr.slice(10, 12), 10);
  const second = Number.parseInt(dateStr.slice(12, 14), 10);
  return Date.UTC(year, month, day, hour, minute, second);
}

describe("migrations bundle", () => {
  test("matches the drizzle .sql files on disk (lockstep)", () => {
    const onDisk = readdirSync(drizzleDir)
      .filter((sub) => existsSync(join(drizzleDir, sub, "migration.sql")))
      .sort((a, b) => a.localeCompare(b));
    expect(MIGRATIONS.map((m) => m.name)).toEqual(onDisk);

    for (const m of MIGRATIONS) {
      const sqlText = readFileSync(join(drizzleDir, m.name, "migration.sql"), "utf8");
      expect(m.sql).toBe(sqlText);
      expect(m.hash).toBe(createHash("sha256").update(sqlText).digest("hex"));
      expect(m.folderMillis).toBe(formatToMillis(m.name.slice(0, 14)));
    }
  });

  test("applyMigrations builds the schema on a fresh database", async () => {
    const db = wrapTurso(await connect(":memory:"));
    await applyMigrations(db);

    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '__turso_internal_%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_migrations'`,
    );
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(
      ["bol_docs", "events", "local_meta", "notes", "requests", "tags", "vendors"].sort(),
    );

    const journal = await db.all<{ name: string; hash: string }>(
      sql`SELECT name, hash FROM __drizzle_migrations`,
    );
    expect(journal.map((j) => j.name)).toEqual(MIGRATIONS.map((m) => m.name));
    const first = MIGRATIONS[0];
    expect(first).toBeDefined();
    expect(journal[0]?.hash).toBe(first?.hash);
  });

  test("applyMigrations is idempotent", async () => {
    const db = wrapTurso(await connect(":memory:"));
    await applyMigrations(db);
    const afterFirst = await db.all<{ name: string }>(
      sql`SELECT name FROM __drizzle_migrations ORDER BY name`,
    );
    await applyMigrations(db);
    const afterSecond = await db.all<{ name: string }>(
      sql`SELECT name FROM __drizzle_migrations ORDER BY name`,
    );
    expect(afterSecond).toEqual(afterFirst);
  });
});
