/**
 * Real {@link SyncEngine} over the Turso embedded-replica `Database` (plan 010,
 * Phase 3). Push then pull, classifying failures so the coordinator can react:
 * 401/403 → {@link AuthError} (refresh once then reauth); anything else →
 * {@link TransientError} (retry with backoff). Before each step the credential
 * store is primed so the replica's `url`/`authToken` callbacks have a token.
 *
 * Exact 401/403 detection depends on the native sync error shape, which is
 * verified on a physical device (the pure coordinator logic is unit-tested
 * with a fake engine). The heuristic checks a status field and common
 * auth-related substrings.
 */

import type { SyncEngine } from "./coordinator";
import { AuthError, TransientError } from "./errors";
import type { SyncCredentialStore } from "./credentialStore";

/** Minimal slice of the Turso `Database` the engine uses. */
export interface SyncClient {
  push(): Promise<void>;
  pull(): Promise<boolean>;
}

export class TursoSyncEngine implements SyncEngine {
  private readonly _client: SyncClient;
  private readonly _creds: SyncCredentialStore;

  constructor(client: SyncClient, creds: SyncCredentialStore) {
    this._client = client;
    this._creds = creds;
  }

  async push(): Promise<void> {
    await this._creds.ensureReady();
    if (this._creds.syncUrl === null) return; // not linked → local-only no-op
    try {
      await this._client.push();
    } catch (e) {
      throw classify(e);
    }
  }

  async pull(): Promise<boolean> {
    await this._creds.ensureReady();
    if (this._creds.syncUrl === null) return false; // not linked → nothing pulled
    try {
      return await this._client.pull();
    } catch (e) {
      throw classify(e);
    }
  }
}

function classify(e: unknown): Error {
  const status = extractStatus(e);
  const msg = e instanceof Error ? e.message : String(e);
  if (status === 401 || status === 403 || /\b(401|403|unauthorized|forbidden)\b/i.test(msg)) {
    return new AuthError(msg);
  }
  return new TransientError(msg);
}

function extractStatus(e: unknown): number | null {
  if (e && typeof e === "object" && "status" in e) {
    const s = (e as { status: unknown }).status;
    return typeof s === "number" ? s : null;
  }
  return null;
}
