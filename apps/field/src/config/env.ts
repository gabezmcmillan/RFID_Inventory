/**
 * Typed, validated field environment — the single place `process.env` is read
 * in `apps/field`. Mirrors the web app's `src/lib/env.ts` house style (one
 * declared seam; raw `process.env` reads anywhere else are an anti-pattern),
 * but with NO `zod` dependency: `zod` is not a direct field dependency and we
 * do not add one for a single URL. Instead the origin is parsed/validated with
 * the built-in `URL` and the shared {@link validateOriginUrl} helper.
 *
 * Expo inlines `EXPO_PUBLIC_*` variables at build time, so this MUST use direct
 * static access (`process.env.EXPO_PUBLIC_DEFAULT_SERVER_URL`) — never dynamic
 * `process.env[varName]` indexing, which Expo cannot inline and which would
 * silently be `undefined` in the bundle.
 *
 * A missing variable is the normal simulator/no-config case: the default falls
 * back to `http://localhost:3000` (only reachable from the iOS simulator,
 * which shares the host's localhost). A configured value must be an exact
 * http/https ORIGIN (no credentials/path/query/hash); an invalid configured
 * value fails loudly at module load (boot) naming ONLY the variable — never
 * its value — so a secret accidentally placed in the env is not echoed.
 *
 * `pnpm tailscale:setup` upserts `EXPO_PUBLIC_DEFAULT_SERVER_URL` into
 * `apps/field/.env.local` from the discovered Tailscale origin; see
 * `docs/local-development.md`.
 */

import { validateOriginUrl } from "./url";

/**
 * The simulator/no-config fallback. Only reachable from the iOS simulator
 * (host's localhost); on a physical device set `EXPO_PUBLIC_DEFAULT_SERVER_URL`
 * to your Tailscale origin (or a production HTTPS URL).
 */
export const FALLBACK_DEFAULT_SERVER_URL = "http://localhost:3000";

/** The env variable name (kept in one place; `pnpm tailscale:setup` writes it). */
export const FIELD_DEFAULT_SERVER_URL_ENV = "EXPO_PUBLIC_DEFAULT_SERVER_URL";

function resolveDefaultServerUrl(): string {
  // Direct static access so Expo can inline it at build time.
  const raw = process.env.EXPO_PUBLIC_DEFAULT_SERVER_URL;
  if (!raw || !raw.trim()) {
    return FALLBACK_DEFAULT_SERVER_URL;
  }
  const v = validateOriginUrl(raw);
  if (!v.ok || !v.origin) {
    // Name ONLY the variable — never echo the configured value (it may be a
    // secret, and echoing it would leak it into logs/crash reports).
    throw new Error(
      `Invalid ${FIELD_DEFAULT_SERVER_URL_ENV} (set in apps/field/.env.local): ${v.error ?? "invalid origin"}.`,
    );
  }
  return v.origin;
}

/** The validated field environment — read this, never raw `process.env`. */
export const fieldEnv = {
  /** Default web app origin (simulator fallback or validated env origin). */
  defaultServerUrl: resolveDefaultServerUrl(),
  /**
   * `true` for a production (non-dev) bundle. Used to lock the server URL to
   * the build-time default so a production build can't be redirected to an
   * arbitrary host via AsyncStorage (plan 010 Phase 4.2). Tailscale/LAN editing
   * stays dev-only.
   */
  isProductionBuild: !__DEV__,
} as const;
