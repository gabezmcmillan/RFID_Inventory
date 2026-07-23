/**
 * Pure helpers for choosing how the on-device warehouse database is opened
 * (plan 010, Phase 3 operator fix). Kept free of any React-Native / Turso-native
 * import so the regression — "unlinked opens local-only and never constructs
 * sync options" — is unit-testable under node without a device.
 *
 * Contract (see `provider.tsx`):
 * - `local`: the Turso `Database` is constructed with ONLY `{ path }` — no
 *   `url`/`authToken`/`bootstrapIfEmpty`. The native `isSyncConfig()` check then
 *   returns false → `initLocalDatabase()` runs → no sync engine, no HTTP
 *   attempt. This is what prevents the "HTTP request missing URL" startup crash
 *   when the device is not linked (or the credential fetch failed at launch).
 * - `synced`: the credential store backs the `url`/`authToken` callbacks, and
 *   the URL is guaranteed non-null (the provider primes the store first and
 *   {@link resolveEffectiveMode} downgrades to `local` otherwise).
 */

/** How the warehouse DB is opened. */
export type DbMode = "local" | "synced";

/** The minimal slice of the sync credential store that {@link buildDbOpts} reads. */
export interface DbCredSource {
  /** The cached warehouse libSQL URL, or null when not yet primed / not linked. */
  readonly syncUrl: string | null;
  /** Fetch the short-lived sync token (null when not linked). */
  getSyncToken(): Promise<string | null>;
}

/** The options handed to the Turso RN `Database` constructor. */
export interface DbOpts {
  path: string;
  /** Remote URL (or a callback returning it). Omitted entirely in local mode. */
  url?: string | (() => string | null);
  /** Auth token (or a callback). Omitted entirely in local mode. */
  authToken?: string | (() => Promise<string>);
  /** Bootstrap an empty replica from the server. Omitted entirely in local mode. */
  bootstrapIfEmpty?: boolean;
}

/**
 * Pure: resolve the effective open mode. A `synced` request downgrades to
 * `local` when no sync URL is available (unlinked, or the credential fetch
 * failed) — so the native sync engine is never constructed with a null URL.
 * This is the core of the startup-crash fix.
 */
export function resolveEffectiveMode(requested: DbMode, hasSyncUrl: boolean): DbMode {
  if (requested === "local") return "local";
  return hasSyncUrl ? "synced" : "local";
}

/**
 * Pure: build the {@link DbOpts} handed to the Turso `Database` constructor. In
 * `local` mode ONLY `path` is set — no `url`/`authToken`/`bootstrapIfEmpty` — so
 * the native `isSyncConfig()` check returns false and `initLocalDatabase()` runs
 * (no sync engine, no HTTP attempt). In `synced` mode the credential store
 * backs the `url`/`authToken` callbacks; {@link resolveEffectiveMode} must have
 * already downgraded to `local` when the URL is unavailable.
 */
export function buildDbOpts(path: string, mode: DbMode, cred: DbCredSource): DbOpts {
  if (mode === "synced") {
    return {
      path,
      // syncUrl is non-null here (caller ensured it); stable per environment.
      url: () => cred.syncUrl,
      // Short-lived server-minted token; re-fetched near expiry.
      authToken: async () => (await cred.getSyncToken()) ?? "",
      bootstrapIfEmpty: true,
    };
  }
  // Strictly local-only — NO sync options. This is what prevents the
  // "HTTP request missing URL" crash when the device is not linked.
  return { path };
}
