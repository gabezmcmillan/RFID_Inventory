/**
 * Local-only device database + EPC serial allocator (plan 010, Phase 2).
 *
 * `device_id` (the permanently-assigned 2-hex EPC byte) and `epc_serial` (the
 * per-device monotonic serial counter) are kept in a SEPARATE local-only
 * Turso database (`device.db`, opened with no sync URL) — NOT the synced
 * warehouse domain DB. Keeping them out of sync is what makes two replicas
 * never share a serial sequence: each device owns its own counter.
 *
 * `reserveSerials` is atomic (a single `BEGIN IMMEDIATE` transaction bumps
 * the counter by `count` and reads it back), so a crash after reservation
 * but before the labels print wastes those serials but never reuses them.
 */

import { withTransaction, type DomainDb, type EpcSerialAllocator } from "@rfid/domain";
import { Database, getDbPath } from "@tursodatabase/sync-react-native";
import { sql } from "drizzle-orm";

import { drizzleTursoRn } from "./drizzleTursoRnDriver";

/** The local-only device-state database (lazy singleton). */
let deviceDb: DomainDb | null = null;

/** Open (once) and return the local-only device-state database. */
async function openDeviceDb(): Promise<DomainDb> {
  if (deviceDb) return deviceDb;
  const client = new Database({ path: getDbPath("device.db") });
  await client.connect();
  const db = drizzleTursoRn(client);
  await db.run(sql`CREATE TABLE IF NOT EXISTS device_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  deviceDb = db;
  return db;
}

/**
 * The on-device {@link EpcSerialAllocator}. `deviceId()` returns the
 * server-assigned 2-hex byte (set after linking via {@link setDeviceId}), or
 * `""` before linking (the print path is unavailable until then).
 * `reserveSerials` atomically advances the counter and returns the first
 * serial of the reserved range.
 */
export async function getDeviceAllocator(): Promise<EpcSerialAllocator> {
  const db = await openDeviceDb();
  return {
    deviceId: async () => {
      const rows = await db.all<{ value: string }>(sql`SELECT value FROM device_state WHERE key='device_id'`);
      return rows[0]?.value ?? "";
    },
    reserveSerials: async (n: number) => {
      const count = Math.max(1, Math.trunc(n) || 1);
      let total = 0;
      await withTransaction(db, async () => {
        await db.run(sql`INSERT OR IGNORE INTO device_state (key, value) VALUES ('epc_serial', '0')`);
        await db.run(
          sql`UPDATE device_state SET value = CAST(CAST(value AS INTEGER) + ${count} AS TEXT) WHERE key='epc_serial'`,
        );
        const rows = await db.all<{ value: string }>(sql`SELECT value FROM device_state WHERE key='epc_serial'`);
        total = Number.parseInt(rows[0]?.value ?? "0", 10);
      });
      return total - count + 1;
    },
  };
}

/**
 * Store the server-assigned 2-hex device id after the QR link/register flow.
 * Local-only (never synced); idempotent.
 */
export async function setDeviceId(id: string): Promise<void> {
  const db = await openDeviceDb();
  await db.run(
    sql`INSERT INTO device_state (key, value) VALUES ('device_id', ${id}) ON CONFLICT(key) DO UPDATE SET value = ${id}`,
  );
}

/**
 * Reset the local device state (plan 010, Phase 2). Called on unlink: clears
 * the server-assigned device id and zeroes the EPC serial counter so a
 * re-link (which assigns a fresh, never-reused byte) starts a clean device.
 * Local-only; never synced.
 */
export async function resetDeviceState(): Promise<void> {
  const db = await openDeviceDb();
  await db.run(sql`DELETE FROM device_state WHERE key IN ('device_id', 'epc_serial')`);
}
