/**
 * Sync credential store — the bridge between the device-linking auth module and
 * the Turso embedded-replica `authToken`/`url` callbacks (plan 010, Phase 3).
 *
 * The Turso `Database` is opened with:
 *   - `url: () => store.syncUrl`  (null until the first token fetch primes it)
 *   - `authToken: () => store.getSyncToken()`  (short-lived, server-minted)
 *
 * `ensureReady()` is called by the sync engine before each push/pull: if a
 * bearer is stored it fetches a fresh short-lived token + the warehouse URL
 * (cached until near expiry); if no bearer (device not linked) it is a no-op so
 * the database stays local-only. `refresh()` forces a re-mint (used by the
 * coordinator on a single 401/403). `clear()` drops the cache on unlink.
 */

import {
  fetchSyncToken,
  getLinkedToken,
  getServerUrl,
  type SyncTokenResult,
} from "../auth/credential";
import { AuthError } from "./errors";

/** Refresh a little before the reported expiry to avoid races. */
const EXPIRY_SKEW_MS = 30_000;

export class SyncCredentialStore {
  private cached: SyncTokenResult | null = null;
  private fetchedAt = 0;

  /** The cached warehouse libSQL URL, or null when not yet primed / not linked. */
  get syncUrl(): string | null {
    return this.cached?.url ?? null;
  }

  /** The cached sync token, or null when not yet primed / not linked. */
  get syncToken(): string | null {
    return this.cached?.token ?? null;
  }

  /**
   * The Turso `authToken` callback. Returns the cached token, fetching a fresh
   * one when there is none or it is near expiry. Throws AuthError when the
   * server denies a refresh (revoked/unlinked) so the coordinator can go reauth.
   * Returns null when no bearer is stored (not linked) — the engine treats that
   * as "local-only, skip sync".
   */
  async getSyncToken(): Promise<string | null> {
    await this.ensureReady();
    return this.syncToken;
  }

  /**
   * Fetch a short-lived token + URL when a bearer is present and the cache is
   * missing or near expiry. No-op when not linked. Idempotent.
   */
  async ensureReady(): Promise<void> {
    const bearer = await getLinkedToken();
    if (!bearer) return; // not linked — stay local-only
    if (this.cached && !this.isExpiringSoon()) return;
    await this.fetch(bearer);
  }

  /** Force a re-mint (coordinator calls this on a 401/403, once). */
  async refreshSyncToken(): Promise<void> {
    const bearer = await getLinkedToken();
    if (!bearer) throw new AuthError("no linked credential");
    await this.fetch(bearer);
  }

  /** Drop the cache (called on unlink/relink). */
  clear(): void {
    this.cached = null;
    this.fetchedAt = 0;
  }

  private async fetch(bearer: string): Promise<void> {
    const serverUrl = await getServerUrl();
    let result: SyncTokenResult;
    try {
      result = await fetchSyncToken(serverUrl, bearer);
    } catch (e) {
      // The credential endpoint returns 403 for revoked/unlinked devices and a
      // network message for unreachable servers. Only map 403 (and explicit auth
      // messages) to AuthError; everything else bubbles as transient.
      const msg = e instanceof Error ? e.message : String(e);
      if (/403|forbidden|not permitted|no active|re-link/i.test(msg)) {
        throw new AuthError(msg);
      }
      throw e;
    }
    this.cached = result;
    this.fetchedAt = Date.now();
  }

  private isExpiringSoon(): boolean {
    if (!this.cached) return true;
    const expiresAt = this.fetchedAt + this.cached.expiresAt * 1000;
    return Date.now() >= expiresAt - EXPIRY_SKEW_MS;
  }
}
