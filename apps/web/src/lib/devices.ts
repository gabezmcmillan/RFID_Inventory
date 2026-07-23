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
  /** Operator soft-deactivate timestamp (active=0, session kept so reactivation is a flip). */
  deactivated_at: string | null;
  /** Last time the device minted a sync token / pinged the credential endpoint. */
  last_seen_at: string | null;
  /** Last time the device completed a successful sync cycle (best-effort proxy). */
  last_sync_at: string | null;
}

export interface AuthMetaRow {
  key: string;
  value: string;
}

/** Minimal Kysely DB interface — only the tables this repo queries. */
interface AuthDbSchema {
  field_devices: FieldDeviceRow;
  auth_meta: AuthMetaRow;
  /** Better Auth `user` table (partial — only the columns the linker join reads). */
  user: BetterAuthUserRow;
}

/** The Better Auth user columns the device registry joins on (linked-by display). */
export interface BetterAuthUserRow {
  id: string;
  email: string;
  name: string;
}

/** A device row joined to its linker's identity, for the admin registry view. */
export interface DeviceWithLinker extends FieldDeviceRow {
  linked_by_email: string | null;
  linked_by_name: string | null;
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
    unlinked_at TEXT,
    deactivated_at TEXT,
    last_seen_at TEXT,
    last_sync_at TEXT
  )`.execute(k);
  await sql`CREATE TABLE IF NOT EXISTS auth_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`.execute(k);
  // Forward-add columns to an existing table (pre-existing auth DBs created
  // before last_seen_at/last_sync_at/deactivated_at were introduced). Each
  // ALTER is guarded by a PRAGMA table_info check so it is idempotent.
  await addColumnIfMissing(k, "field_devices", "deactivated_at", "TEXT");
  await addColumnIfMissing(k, "field_devices", "last_seen_at", "TEXT");
  await addColumnIfMissing(k, "field_devices", "last_sync_at", "TEXT");
  schemaEnsured = true;
}

/** Add a column to a table only if it is not already present (idempotent). */
async function addColumnIfMissing(
  k: Kysely<AuthDbSchema>,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const cols = await sql<{ name: string }>`PRAGMA table_info(${sql.ref(table)})`.execute(k);
  const present = cols.rows.some((r) => r.name === column);
  if (!present) {
    await sql`ALTER TABLE ${sql.ref(table)} ADD COLUMN ${sql.ref(column)} ${sql.raw(definition)}`.execute(k);
  }
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

// ---- Registry lifecycle (operator admin, plan 010 scope addition) -----------

/**
 * Every device row joined to its linker's identity, newest first. The linker
 * (`user_id`) is the person who scanned the QR — NOT necessarily the daily
 * operator — so the admin UI labels it "Linked by", never "Owner".
 */
export async function listDevicesWithLinker(): Promise<DeviceWithLinker[]> {
  await ensureAuthSchema();
  const k = getAuthKysely();
  const rows = await k
    .selectFrom("field_devices as d")
    .leftJoin("user as u", "u.id", "d.user_id")
    .select([
      "d.id as id",
      "d.user_id as user_id",
      "d.session_id as session_id",
      "d.epc_byte as epc_byte",
      "d.label as label",
      "d.active as active",
      "d.created_at as created_at",
      "d.revoked_at as revoked_at",
      "d.unlinked_at as unlinked_at",
      "d.deactivated_at as deactivated_at",
      "d.last_seen_at as last_seen_at",
      "d.last_sync_at as last_sync_at",
      "u.email as linked_by_email",
      "u.name as linked_by_name",
    ])
    .orderBy("d.created_at", "desc")
    .execute();
  return rows as unknown as DeviceWithLinker[];
}

/**
 * Rename a device's display label. Returns true when a row was updated, false
 * when the device was not found. The label is clamped to 64 chars by the caller.
 */
export async function renameDevice(deviceId: string, label: string): Promise<boolean> {
  await ensureAuthSchema();
  const k = getAuthKysely();
  const res = await k
    .updateTable("field_devices")
    .set({ label })
    .where("id", "=", deviceId)
    .executeTakeFirst();
  return Number(res?.numUpdatedRows ?? 0) > 0;
}

/**
 * Operator soft-deactivate: set `active=0` and record `deactivated_at`. The
 * Better Auth session is KEPT (unlike revoke/unlink), so reactivation is a
 * simple flip back without re-linking. Credential refresh is blocked because
 * {@link getActiveDeviceForUser} returns null for an inactive device, so the
 * field app's pushes stop within the sync-token TTL. Returns true when a row
 * was updated, false when the device was not found / already inactive.
 */
export async function deactivateDevice(deviceId: string): Promise<boolean> {
  await ensureAuthSchema();
  const k = getAuthKysely();
  const res = await k
    .updateTable("field_devices")
    .set({ active: 0, deactivated_at: new Date().toISOString() })
    .where("id", "=", deviceId)
    .where("active", "=", 1)
    .executeTakeFirst();
  return Number(res?.numUpdatedRows ?? 0) > 0;
}

/**
 * Reactivate a soft-deactivated device: set `active=1` and clear
 * `deactivated_at`. The kept session means the field app can mint sync tokens
 * again immediately (its coordinator resumes via the manual "retry" escape
 * hatch after the operator reactivates). Returns true when a row was updated,
 * false when the device was not found / already active.
 */
export async function reactivateDevice(deviceId: string): Promise<boolean> {
  await ensureAuthSchema();
  const k = getAuthKysely();
  const res = await k
    .updateTable("field_devices")
    .set({ active: 1, deactivated_at: null })
    .where("id", "=", deviceId)
    .where("active", "=", 0)
    .executeTakeFirst();
  return Number(res?.numUpdatedRows ?? 0) > 0;
}

/**
 * Bump `last_seen_at` (and optionally `last_sync_at`) for a device. Called by
 * the credential endpoint on each token mint — a proxy for "the device is
 * alive and syncing". Best-effort: a missing row is a no-op.
 */
export async function touchDevice(
  deviceId: string,
  opts: { lastSync?: boolean } = {},
): Promise<void> {
  await ensureAuthSchema();
  const k = getAuthKysely();
  const now = new Date().toISOString();
  const set: Record<string, string | null> = { last_seen_at: now };
  if (opts.lastSync) set.last_sync_at = now;
  await k.updateTable("field_devices").set(set).where("id", "=", deviceId).execute();
}
