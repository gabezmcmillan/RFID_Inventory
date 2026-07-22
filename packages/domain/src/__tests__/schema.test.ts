import { describe, expect, test } from "vitest";

import { openTestDb } from "../testing/openTestDb.js";

describe("schema", () => {
  test("creates exactly the expected tables", async () => {
    const db = await openTestDb();
    const rows = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = rows.map((r) => r.name);
    expect(names).toEqual([
      "bol_docs",
      "events",
      "local_meta",
      "notes",
      "requests",
      "sqlite_sequence",
      "tags",
      "vendors",
    ]);
  });

  test("tags keeps epc UNIQUE NOT NULL and the bol_doc_id column", async () => {
    const db = await openTestDb();
    const cols = await db.all<{ name: string; notnull: number; dflt_value: string | null }>(
      "PRAGMA table_info(tags)",
    );
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("epc")?.notnull).toBe(1);
    expect(byName.has("bol_doc_id")).toBe(true);
    expect(byName.get("status")?.dflt_value).toBe("'In Warehouse'");

    // UNIQUE constraint present (epc TEXT UNIQUE creates an auto-index with
    // origin 'u'; its `sql` column is NULL, so check origin instead).
    const idx = await db.all<{ name: string; origin: string }>(
      "PRAGMA index_list(tags)",
    );
    expect(idx.some((r) => r.origin === "u")).toBe(true);
  });

  test("requests has no status_dirty and has updated_at; id is autoincrement", async () => {
    const db = await openTestDb();
    const cols = await db.all<{ name: string }>("PRAGMA table_info(requests)");
    const names = cols.map((c) => c.name);
    expect(names).not.toContain("status_dirty");
    expect(names).toContain("updated_at");
    const seq = await db.get<{ seq: string }>(
      "SELECT seq FROM sqlite_sequence WHERE name='requests'",
    );
    expect(seq).toBeUndefined(); // no rows inserted yet -> no sequence entry
  });
});
