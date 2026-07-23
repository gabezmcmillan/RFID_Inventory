/**
 * Phase 2 — collision-safe global text IDs: proves `newId` is unique/valid
 * UUIDv4, two replicas minting offline never collide, a text `bol_doc_id`
 * links a tag to its document, and the `text-ids` migration preserves
 * existing rows (legacy integer id → text).
 */

import { connect } from "@tursodatabase/database";
import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { newId } from "../id";
import { applyMigrations } from "../applyMigrations";
import { MIGRATIONS } from "../migrations";
import { bolDocs, tags } from "../schema";
import { wrapTurso } from "../testing/openTestDb";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const epc = (prefix: string): string => prefix.padEnd(24, "0").slice(0, 24);

describe("global text IDs (Phase 2)", () => {
  test("newId is a unique valid UUIDv4 across many calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      const id = newId();
      expect(id).toMatch(UUID_RE);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    expect(ids.size).toBe(10000);
  });

  test("two replicas inserting with newId never collide on id", async () => {
    const a = wrapTurso(await connect(":memory:"));
    const b = wrapTurso(await connect(":memory:"));
    await applyMigrations(a);
    await applyMigrations(b);

    const idA = newId();
    const idB = newId();
    expect(idA).not.toBe(idB);
    await a.insert(tags).values({
      id: idA, epc: epc("AAAA"), item_type: "TSC",
      received_at: "t", created_at: "t", updated_at: "t",
    });
    await b.insert(tags).values({
      id: idB, epc: epc("BBBB"), item_type: "TSC",
      received_at: "t", created_at: "t", updated_at: "t",
    });

    // Merge replica B's row into A: distinct ids + epcs ⇒ no PK/unique collision.
    const bRow = await b.select().from(tags).where(eq(tags.id, idB));
    await a.insert(tags).values(bRow[0]!);
    const all = (await a.select({ id: tags.id }).from(tags)).map((r) => r.id).sort();
    expect(all).toEqual([idA, idB].sort());
  });

  test("a text bol_doc_id links a tag to its bol_doc", async () => {
    const db = wrapTurso(await connect(":memory:"));
    await applyMigrations(db);

    const docId = newId();
    await db.insert(bolDocs).values({
      id: docId, bol_number: "B1", filename: "b1.pdf", created_at: "t",
    });
    const tagId = newId();
    await db.insert(tags).values({
      id: tagId, epc: epc("CCCC"), bol_doc_id: docId, item_type: "TSC",
      received_at: "t", created_at: "t", updated_at: "t",
    });

    const link = await db.select({ bolDocId: tags.bol_doc_id }).from(tags).where(eq(tags.id, tagId));
    expect(link[0]?.bolDocId).toBe(docId);
    const doc = await db.select({ id: bolDocs.id }).from(bolDocs).where(eq(bolDocs.id, docId));
    expect(doc[0]?.id).toBe(docId);
  });

  test("the text-ids migration preserves existing rows (integer id -> text)", async () => {
    const db = wrapTurso(await connect(":memory:"));
    // Apply only the first (integer-PK) migration manually.
    const first = MIGRATIONS[0]!;
    for (const stmt of first.sql.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s.length > 0) await db.run(sql.raw(s));
    }
    // Record it in the journal so applyMigrations skips it and only applies the
    // second (text-ids) migration.
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT
      )
    `);
    await db.run(sql`
      INSERT INTO __drizzle_migrations ("hash","created_at","name","applied_at")
      VALUES (${first.hash}, ${first.folderMillis}, ${first.name}, ${new Date().toISOString()})
    `);
    // A legacy integer-id row.
    await db.run(sql`
      INSERT INTO tags (id, epc, item_type, received_at, created_at, updated_at)
      VALUES (7, ${epc("42473031")}, 'TSC', 't', 't', 't')
    `);

    // Apply the second migration: rebuilds tags with a text PK, preserving rows.
    await applyMigrations(db);

    // The row survived; its integer id is now text "7".
    const row = await db.all<{ id: string; epc: string }>(
      sql`SELECT id, epc FROM tags WHERE epc=${epc("42473031")}`,
    );
    expect(row[0]?.id).toBe("7");

    // New inserts must use a text id (autoincrement is gone).
    const id = newId();
    await db.insert(tags).values({
      id, epc: epc("DDDD"), item_type: "TSC",
      received_at: "t", created_at: "t", updated_at: "t",
    });
    const got = await db.select({ id: tags.id }).from(tags).where(eq(tags.id, id));
    expect(got[0]?.id).toBe(id);
  });
});
