import { Kysely } from "kysely";
import { LibsqlDialect } from "kysely-libsql";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  __setAuthKyselyForTesting,
  allocateNextEpcByte,
  deactivateDevice,
  deleteSessionById,
  getActiveDeviceForUser,
  insertDevice,
  listDevicesWithLinker,
  reactivateDevice,
  renameDevice,
  revokeDevice,
  touchDevice,
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
    deactivated_at: null,
    last_seen_at: null,
    last_sync_at: null,
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

describe("field_devices registry lifecycle (admin)", () => {
  let k: Kysely<unknown>;
  beforeEach(async () => {
    k = inMemoryAuthDb();
    __setAuthKyselyForTesting(k as never, false);
    // The linker join reads the Better Auth `user` table; create it so the join
    // has a table to left-join on (rows may still be missing — that's the test).
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT, name TEXT)`.execute(k);
  });
  afterEach(() => {
    __setAuthKyselyForTesting(null);
  });

  test("listDevicesWithLinker joins the linker's identity and orders newest-first", async () => {
    await sql`INSERT INTO user (id, email, name) VALUES ('user-1', 'ops@acme.com', 'Ops')`.execute(k);
    await insertDevice(row({ id: "old", epc_byte: "01", created_at: "2026-01-01T00:00:00Z" }));
    await insertDevice(row({ id: "new", epc_byte: "02", created_at: "2026-07-01T00:00:00Z" }));
    const list = await listDevicesWithLinker();
    expect(list.map((d) => d.id)).toEqual(["new", "old"]);
    expect(list[0].linked_by_email).toBe("ops@acme.com");
    expect(list[0].linked_by_name).toBe("Ops");
  });

  test("listDevicesWithLinker tolerates a missing user row (linked_by null)", async () => {
    await insertDevice(row({ id: "d", epc_byte: "03", user_id: "ghost" }));
    const list = await listDevicesWithLinker();
    expect(list[0].linked_by_email).toBeNull();
    expect(list[0].linked_by_name).toBeNull();
  });

  test("renameDevice updates the label and returns false for an unknown device", async () => {
    await insertDevice(row({ id: "d", label: "old" }));
    expect(await renameDevice("d", "Warehouse iPad")).toBe(true);
    const r = ((await sql`SELECT label FROM field_devices WHERE id='d'`.execute(k))).rows[0] as Record<string, unknown>;
    expect(r.label).toBe("Warehouse iPad");
    expect(await renameDevice("nope", "x")).toBe(false);
  });

  test("deactivateDevice blocks credential refresh (active=0) and records deactivated_at", async () => {
    await insertDevice(row({ id: "d", session_id: "sess-1" }));
    expect(await deactivateDevice("d")).toBe(true);
    expect(await getActiveDeviceForUser("user-1")).toBeNull();
    const r = ((await sql`SELECT active, deactivated_at, session_id FROM field_devices WHERE id='d'`.execute(k))).rows[0] as Record<string, unknown>;
    expect(r.active).toBe(0);
    expect(r.deactivated_at).not.toBeNull();
    // The session is KEPT (reactivation is a flip, not a re-link).
    expect(r.session_id).toBe("sess-1");
    // Idempotent: a second deactivate is a no-op.
    expect(await deactivateDevice("d")).toBe(false);
  });

  test("reactivateDevice flips active back on and clears deactivated_at", async () => {
    await insertDevice(row({ id: "d" }));
    await deactivateDevice("d");
    expect(await getActiveDeviceForUser("user-1")).toBeNull();
    expect(await reactivateDevice("d")).toBe(true);
    expect((await getActiveDeviceForUser("user-1"))?.id).toBe("d");
    const r = ((await sql`SELECT active, deactivated_at FROM field_devices WHERE id='d'`.execute(k))).rows[0] as Record<string, unknown>;
    expect(r.active).toBe(1);
    expect(r.deactivated_at).toBeNull();
  });

  test("touchDevice bumps last_seen_at and last_sync_at", async () => {
    await insertDevice(row({ id: "d" }));
    await touchDevice("d", { lastSync: true });
    const r = ((await sql`SELECT last_seen_at, last_sync_at FROM field_devices WHERE id='d'`.execute(k))).rows[0] as Record<string, unknown>;
    expect(r.last_seen_at).not.toBeNull();
    expect(r.last_sync_at).not.toBeNull();
  });

  test("deactivate then reactivate is unambiguous and distinct from revoke", async () => {
    await insertDevice(row({ id: "d", session_id: "sess-1" }));
    await deactivateDevice("d");
    await reactivateDevice("d");
    // After a full deactivate/reactivate cycle the device is active and the
    // session is intact (no re-link needed) — unlike revoke, which retires it.
    const r = ((await sql`SELECT active, session_id, revoked_at FROM field_devices WHERE id='d'`.execute(k))).rows[0] as Record<string, unknown>;
    expect(r.active).toBe(1);
    expect(r.session_id).toBe("sess-1");
    expect(r.revoked_at).toBeNull();
  });
});
