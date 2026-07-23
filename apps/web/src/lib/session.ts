/**
 * Session helper: the single seam server components and server actions use to
 * resolve the signed-in user. Returns the user's name/email (for prefilling the
 * checkout form's requester/contact) or `null` when there is no session.
 *
 * Two code paths, in order:
 *
 * 1. **Dev bypass** (grep-able, one code path): when
 *    `AUTH_DEV_BYPASS === "1"` AND `NODE_ENV !== "production"` it returns a fake
 *    user so local dev works without Entra credentials. The `NODE_ENV` guard is
 *    on the same expression as `AUTH_DEV_BYPASS`, so it is impossible to enable
 *    in production — `AUTH_DEV_BYPASS=1` in prod is a no-op (the `&&` short-
 *    circuits). The fake user's name/email are env-tunable
 *    (`AUTH_DEV_BYPASS_NAME` / `AUTH_DEV_BYPASS_EMAIL`) with defaults.
 *
 * 2. **Real session**: when a live auth backend is configured (`getAuth()` is
 *    not `null`) it calls `auth.api.getSession({ headers })` and maps the
 *    principal to `{ name, email }`. Offline (`getAuth()` is `null`) it returns
 *    `null` — the page then redirects to `/sign-in`.
 */

import { cache } from "react";
import { headers } from "next/headers";

import { getAuth } from "@/lib/auth";

/** The signed-in user's display name + email, used to prefill the checkout form. */
export interface SessionUser {
  name: string;
  email: string;
}

/** Default fake principal for the dev bypass. */
const DEFAULT_BYPASS_NAME = "Dev User";
const DEFAULT_BYPASS_EMAIL = "dev@example.local";

/**
 * Whether the dev bypass is active. The `NODE_ENV !== "production"` guard is
 * on the same expression as `AUTH_DEV_BYPASS` so a grep for either finds both,
 * and the bypass cannot activate in production.
 */
export function isDevBypassActive(): boolean {
  return process.env.AUTH_DEV_BYPASS === "1" && process.env.NODE_ENV !== "production";
}

/** The fake principal returned while the dev bypass is active. */
function devBypassUser(): SessionUser {
  return {
    name: process.env.AUTH_DEV_BYPASS_NAME ?? DEFAULT_BYPASS_NAME,
    email: process.env.AUTH_DEV_BYPASS_EMAIL ?? DEFAULT_BYPASS_EMAIL,
  };
}

/**
 * Resolve the signed-in user for the current request, or `null`. Server
 * components and server actions share this one code path. Memoized per request
 * with `React.cache` (`server-cache-react`) so the several Server Components
 * that ask for the principal on one render (page + header + cart action) share
 * a single session resolution rather than re-querying Better Auth each time.
 */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  if (isDevBypassActive()) {
    return devBypassUser();
  }
  const auth = getAuth();
  if (auth === null) {
    return null;
  }
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) {
    return null;
  }
  return { name: session.user.name, email: session.user.email };
});
