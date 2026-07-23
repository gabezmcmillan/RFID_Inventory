/**
 * Dev bypass — edge-safe, pure environment reads only.
 *
 * Split out of `session.ts` so the Next.js proxy (Edge Runtime) can import
 * {@link isDevBypassActive} WITHOUT dragging in `session.ts` → `auth.ts` →
 * `node:path` / `kysely-libsql` / `betterAuth`, none of which the Edge Runtime
 * can load. This module reads only the validated env (`@/lib/env`, itself
 * edge-safe — zod + `process.env`, no Node-only imports), so it is safe to
 * import from the proxy.
 *
 * The bypass is grep-able and impossible to enable in production: the
 * `NODE_ENV !== "production"` guard sits on the SAME `&&` expression as
 * `AUTH_DEV_BYPASS`, so `AUTH_DEV_BYPASS=1` in prod short-circuits to false.
 */

import { env } from "@/lib/env";

/** The signed-in user's display name + email, used to prefill the checkout form. */
export interface SessionUser {
  name: string;
  email: string;
}

/** Default fake principal for the dev bypass. */
const DEFAULT_BYPASS_NAME = "Dev User";
const DEFAULT_BYPASS_EMAIL = "dev@example.local";

/**
 * Whether the dev bypass is active. The `NODE_ENV !== "production"` guard is on
 * the same expression as `AUTH_DEV_BYPASS` so a grep for either finds both, and
 * the bypass cannot activate in production.
 */
export function isDevBypassActive(): boolean {
  return env.AUTH_DEV_BYPASS === "1" && env.NODE_ENV !== "production";
}

/** The fake principal returned while the dev bypass is active. */
export function devBypassUser(): SessionUser {
  return {
    name: env.AUTH_DEV_BYPASS_NAME ?? DEFAULT_BYPASS_NAME,
    email: env.AUTH_DEV_BYPASS_EMAIL ?? DEFAULT_BYPASS_EMAIL,
  };
}
