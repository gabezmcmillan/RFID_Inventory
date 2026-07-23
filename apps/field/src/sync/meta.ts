/**
 * {@link MetaProvider} that reads the server's synced `schema_version` from the
 * local `local_meta` table (plan 010, Phase 3). The web app writes this row
 * after migrating the warehouse DB, so it replicates down to every replica; the
 * coordinator compares it to the build's `SCHEMA_VERSION` and blocks writes
 * when the server is ahead (upgrade required). Returns null when the row is
 * absent (e.g. a fresh replica before the first pull) — treated as compatible.
 */

import type { DomainDb } from "@rfid/domain";
import { getMeta } from "@rfid/domain";
import type { MetaProvider } from "./coordinator";

export const SCHEMA_VERSION_META_KEY = "schema_version";

export class DomainMetaProvider implements MetaProvider {
  private readonly _db: DomainDb;

  constructor(db: DomainDb) {
    this._db = db;
  }

  async getRemoteSchemaVersion(): Promise<number | null> {
    const raw = await getMeta(this._db, SCHEMA_VERSION_META_KEY);
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
}
