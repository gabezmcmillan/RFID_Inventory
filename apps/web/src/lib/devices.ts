/**
 * Auth-database access for field devices (plan 010, Phase 2). The `field_devices`
 * table lives in the SEPARATE auth database (alongside Better Auth's
 * user/session/account/verification tables) — never in the warehouse domain DB
 * the phone syncs. A Kysely instance over the shared libSQL auth dialect is the
 * sole writer here; the warehouse Drizzle layer never touches it.
 *
 * Schema is ensured idempotently (CREATE TABLE IF NOT EXISTS) once per process
 * before any device operation, so deploying needs no separate migration step
 * beyond Better Auth's own `auth:migrate`.
 */

import { Kysely, sql } from "kysely";

import { buildAuthDialect } from "@/lib/auth";

/** Columns the device repo reads/writes (a partial view of the auth DB). */
export interface FieldDeviceRow {
  id: string;
  user_id: string;
  session_id: string | null;
  epc_byte: string;
  label: string | null;
  active: number;
  created_at: string;
  revoked_at: string | null;
  unlinked_at: string | null;
}

export interface AuthMetaRow {
  key: string;
  value: string;
}

/** Minimal Kysely DB interface — only the tables this repo queries. */
interface AuthDbSchema {
  field_devices: FieldDeviceRow;
  auth_meta: AuthMetaRow;
}

let db: Kysely<AuthDbSchema> | null = null;
let schemaEnsured = false;

/** The shared Kysely instance over the auth database (memoized per process). */
export function getAuthKysely(): Kysely<AuthDbSchema> {
  if (!db) {
    db = new Kysely<AuthDbSchema>({ dialect: buildAuthDialect() });
  }
  return db;
}

/**
 * Test-only: inject an alternate Kysely instance (e.g. an in-memory libSQL
 * database) and mark the schema as already ensured. Production code never
 * calls this. Restored by passing `null`.
 */
export function __setAuthKyselyForTesting(
  override: Kysely<AuthDbSchema> | null,
  ensured = false,
): void {
  db = override;
  schemaEnsured = ensured;
}

/** Idempotently create the custom `field_devices` + `auth_meta` tables. */
export async function ensureAuthSchema(): Promise<void> {
  if (schemaEnsured) return;
  const k = getAuthKysely();
  await sql`CREATE TABLE IF NOT EXISTS field_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    epc_byte TEXT NOT NULL UNIQUE,
    label TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    unlinked_at TEXT
  )`.execute(k);
  await sql`CREATE TABLE IF NOT EXISTS auth_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`.execute(k);
  schemaEnsured = true;
}

/**
 * Atomically allocate the next permanent 2-hex EPC device byte. Advances the
 * `epc_byte_counter` in `auth_meta` and returns the byte for the counter value
 * just consumed. Bytes are never reused (the counter only increases); a revoked
 * device's byte stays retired.
 *
 * @returns the assigned 2-hex byte, or `null` once all 256 bytes are exhausted.
 */
export async function allocateNextEpcByte(): Promise<string | null> {
  await ensureAuthSchema();
  const k = getAuthKysely();
  // Atomic upsert+returning: bump the counter and read it back in one statement.
  const row = await sql<{ value: string }>`
    INSERT INTO auth_meta (key, value) VALUES ('epc_byte_counter', '0')
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
    RETURNING value
  `.execute(k);
  const next = Number.parseInt(row.rows[0]?.value ?? "0", 10);
  if (next > 0xff) return null; // exhausted
  return next.toString(16).toUpperCase().padStart(2, "0");
}

/** Insert a new field-device record. */
export async function insertDevice(row: FieldDeviceRow): Promise<void> {
  await ensureAuthSchema();
  const k = getAuthKysely();
  await k.insertInto("field_devices").values(row).execute();
}

/** The single active device for a user, or `null` if none. */
export async function getActiveDeviceForUser(userId: string): Promise<FieldDeviceRow | null> {
  await ensureAuthSchema();
  const k = getAuthKysely();
  const row = await k
    .selectFrom("field_devices")
    .selectAll()
    .where("user_id", "=", userId)
    .where("active", "=", 1)
    .executeTakeFirst();
  return row ?? null;
}

/** A device by id (any state). */
export async function getDevice(deviceId: string): Promise<FieldDeviceRow | null> {
  await ensureAuthSchema();
  const k = getAuthKysely();
  const row = await k.selectFrom("field_devices").selectAll().where("id", "=", deviceId).executeTakeFirst();
  return row ?? null;
}

/**
 * Mark a device inactive (unlinked): clear its session ref, set `active=0` and
 * `unlinked_at`. The EPC byte stays retired (never reused). Returns the row's
 * session id (so the caller can revoke the Better Auth session), or `null` if
 * the device was not found / already inactive.
 */
export async function unlinkDevice(deviceId: string): Promise<string | null> {
  await ensureAuthSchema();
  const k = getAuthKysely();
  const dev = await k
    .selectFrom("field_devices")
    .select("session_id")
    .where("id", "=", deviceId)
    .where("active", "=", 1)
    .executeTakeFirst();
  if (!dev) return null;
  await k
    .updateTable("field_devices")
    .set({ active: 0, session_id: null, unlinked_at: new Date().toISOString() })
    .where("id", "=", deviceId)
    .execute();
  return dev.session_id;
}

/**
 * Operator revocation of a (possibly lost) device: mark inactive + revoked,
 * clear the session ref. Same never-reuse guarantee as unlink. Returns the
 * session id to revoke, or `null` if not found / already inactive.
 */
export async function revokeDevice(deviceId: string): Promise<string | null> {
  await ensureAuthSchema();
  const k = getAuthKysely();
  const dev = await k
    .selectFrom("field_devices")
    .select("session_id")
    .where("id", "=", deviceId)
    .where("active", "=", 1)
    .executeTakeFirst();
  if (!dev) return null;
  await k
    .updateTable("field_devices")
    .set({ active: 0, session_id: null, revoked_at: new Date().toISOString() })
    .where("id", "=", deviceId)
    .execute();
  return dev.session_id;
}

/**
 * Delete a Better Auth `session` row by id (revokes the bearer immediately —
 * the token no longer resolves to a session). Used by unlink/revoke since we
 * store the session id (not the secret token) on the device row. Best-effort:
 * a missing row is a no-op.
 */
export async function deleteSessionById(sessionId: string): Promise<void> {
  await ensureAuthSchema();
  const k = getAuthKysely();
  await sql`DELETE FROM session WHERE id = ${sessionId}`.execute(k);
}
