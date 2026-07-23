/**
 * Schema-version compatibility check (plan 010, Phase 3). Before writing, the
 * coordinator compares the server's synced `schema_version` against the
 * version this build supports (`SCHEMA_VERSION` from `@rfid/domain`). When the
 * server is AHEAD, this build is too old to write safely → block writes and
 * surface "upgrade required". Local data is preserved (never wiped); sync
 * writes are simply held until the app is upgraded.
 */

export type SchemaCheckResult = { ok: true } | { ok: false; reason: "upgrade-required" };

/**
 * @param supported the schema version this build understands (domain
 *   `SCHEMA_VERSION`).
 * @param remote the server's synced schema version (a meta row), or `null`
 *   when not yet known (treat as compatible until proven otherwise — a fresh
 *   pull will populate it).
 */
export function checkSchemaVersion(supported: number, remote: number | null): SchemaCheckResult {
  if (remote === null) return { ok: true };
  if (remote > supported) return { ok: false, reason: "upgrade-required" };
  return { ok: true };
}
