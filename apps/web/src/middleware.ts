import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

import { isDevBypassActive } from "@/lib/session";

/**
 * Auth gate: require a Better Auth session cookie for everything EXCEPT the
 * tag QR pages (`/tag/*`), the health check (`/api/health`), the auth API
 * (`/api/auth/*`), and the sign-in page itself.
 *
 * `getSessionCookie` only checks cookie *presence* (no DB hit) — the Better
 * Auth middleware pattern; the full session is resolved per-request in server
 * components via `getUser()`. When the dev bypass is active (guarded by
 * `NODE_ENV !== "production"` inside {@link isDevBypassActive}) middleware
 * lets every request through, so local dev works without Entra credentials.
 *
 * `effectivly` gates per-page instead of with middleware; this plan's Done
 * criteria require a middleware matcher that excludes `/tag`, so we use
 * middleware here.
 */

/** Paths that never require a session. */
const PUBLIC_PATHS = ["/sign-in"];
const PUBLIC_PREFIXES = ["/tag/", "/api/health", "/api/auth/"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) {
    return true;
  }
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (isDevBypassActive() || isPublic(pathname)) {
    return NextResponse.next();
  }
  const session = getSessionCookie(request);
  if (!session) {
    const signIn = new URL("/sign-in", request.url);
    return NextResponse.redirect(signIn);
  }
  return NextResponse.next();
}

/**
 * Run on every route EXCEPT the public ones (and Next internals). The `/tag`
 * exclusion lives here so a grep for `tag` in this file finds the matcher.
 */
export const config = {
  matcher: [
    "/((?!tag/|api/health|api/auth/|sign-in|_next/|favicon\\.ico).*)",
  ],
};
