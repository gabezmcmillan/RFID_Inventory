import { Kysely } from "kysely";
import { LibsqlDialect } from "kysely-libsql";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  __setAuthKyselyForTesting,
  allocateNextEpcByte,
  deleteSessionById,
  getActiveDeviceForUser,
  insertDevice,
  revokeDevice,
  unlinkDevice,
  type FieldDeviceRow,
} from "@/lib/devices";

/** Build a fresh in-memory auth DB (separate from any warehouse DB) for a test. */
function inMemoryAuthDb(): Kysely<unknown> {
  return new Kysely({ dialect: new LibsqlDialect({ url: ":memory:" }) });
}

function row(over: Partial<FieldDeviceRow> = {}): FieldDeviceRow {
  return {
    id: "dev-1",
    user_id: "user-1",
    session_id: "sess-1",
    epc_byte: "01",
    label: null,
    active: 1,
    created_at: "t",
    revoked_at: null,
    unlinked_at: null,
    ...over,
  };
}

describe("field_devices repo (auth DB, in-memory)", () => {
  let k: Kysely<unknown>;
  beforeEach(() => {
    k = inMemoryAuthDb();
    __setAuthKyselyForTesting(k as never, false);
  });
  afterEach(() => {
    __setAuthKyselyForTesting(null);
  });

  test("insert + active lookup round-trips", async () => {
    await insertDevice(row());
    const active = await getActiveDeviceForUser("user-1");
    expect(active?.id).toBe("dev-1");
    expect(active?.epc_byte).toBe("01");
  });

  test("unlink marks the device inactive and clears its session ref", async () => {
    await insertDevice(row());
    const sessionId = await unlinkDevice("dev-1");
    expect(sessionId).toBe("sess-1");
    expect(await getActiveDeviceForUser("user-1")).toBeNull();
    const inactive = ((await sql`SELECT active, session_id, unlinked_at FROM field_devices WHERE id='dev-1'`.execute(k))).rows[0] as Record<string, unknown> | undefined;
    expect(inactive?.active).toBe(0);
    expect(inactive?.session_id).toBeNull();
    expect(inactive?.unlinked_at).not.toBeNull();
  });

  test("revoke marks the device inactive + revoked and clears its session ref", async () => {
    await insertDevice(row());
    const sessionId = await revokeDevice("dev-1");
    expect(sessionId).toBe("sess-1");
    expect(await getActiveDeviceForUser("user-1")).toBeNull();
    const r = ((await sql`SELECT active, revoked_at FROM field_devices WHERE id='dev-1'`.execute(k))).rows[0] as Record<string, unknown> | undefined;
    expect(r?.active).toBe(0);
    expect(r?.revoked_at).not.toBeNull();
  });

  test("unlink/revoke on an unknown or already-inactive device returns null (idempotent)", async () => {
    expect(await unlinkDevice("nope")).toBeNull();
    await insertDevice(row());
    await unlinkDevice("dev-1");
    expect(await unlinkDevice("dev-1")).toBeNull(); // already inactive
    expect(await revokeDevice("dev-1")).toBeNull();
  });

  test("allocateNextEpcByte is monotonic and never reuses a byte", async () => {
    expect(await allocateNextEpcByte()).toBe("00");
    expect(await allocateNextEpcByte()).toBe("01");
    expect(await allocateNextEpcByte()).toBe("02");
    // The counter is independent of inserted device rows and only advances —
    // revoking a device never frees its byte for reuse.
    await insertDevice(row({ id: "d", epc_byte: "AA" }));
    await revokeDevice("d");
    expect(await allocateNextEpcByte()).toBe("03");
    expect(await allocateNextEpcByte()).toBe("04");
  });

  test("allocateNextEpcByte returns null once all 256 bytes are exhausted", async () => {
    for (let i = 0; i < 256; i++) {
      const b = await allocateNextEpcByte();
      expect(b).not.toBeNull();
    }
    expect(await allocateNextEpcByte()).toBeNull();
  });

  test("deleteSessionById removes the Better Auth session row", async () => {
    await sql`CREATE TABLE session (id TEXT PRIMARY KEY, expires_at INTEGER)`.execute(k);
    await sql`INSERT INTO session (id, expires_at) VALUES ('sess-1', 0)`.execute(k);
    await deleteSessionById("sess-1");
    const r = ((await sql`SELECT COUNT(*) AS n FROM session WHERE id='sess-1'`.execute(k))).rows[0] as Record<string, unknown> | undefined;
    expect(Number(r?.n ?? 0)).toBe(0);
  });

  test("the device table is isolated from the warehouse schema (auth-only)", async () => {
    // The auth DB here is a standalone in-memory libSQL with ONLY field_devices
    // + auth_meta + session — no warehouse tables (tags/events/etc.) exist.
    await insertDevice(row());
    const tables = ((await sql`SELECT name FROM sqlite_master WHERE type='table'`.execute(k))).rows.map((r) => (r as Record<string, unknown>).name);
    expect(tables).toContain("field_devices");
    expect(tables).toContain("auth_meta");
    expect(tables.some((t) => t === "tags" || t === "events")).toBe(false);
  });
});
