import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

import { isDevBypassActive } from "@/lib/dev-bypass";

/**
 * Auth gate (Next.js 16 "proxy" — the renamed middleware convention): require a
 * Better Auth session cookie for EVERY route except an explicit, documented
 * public allowlist. The operator decision (2026-07-23): the whole cloud app
 * requires login. See `docs/operations/sync-security-decision.md` §
 * "Cloud app auth gate — require login globally".
 *
 * `getSessionCookie` only checks cookie *presence* (no DB hit) — the Better
 * Auth middleware pattern; the full session is resolved per-request in server
 * components via `getUser()`. When the dev bypass is active (guarded by
 * `NODE_ENV !== "production"` inside {@link isDevBypassActive}) the proxy lets
 * every request through, so local dev works without Entra credentials.
 * Production always requires a real session — the bypass short-circuits to
 * false in prod.
 *
 * Next.js 16 renamed `middleware.ts` → `proxy.ts` and the exported `middleware`
 * function → `proxy` (see the installed
 * `next/dist/docs/01-app/01-getting-started/16-proxy.md`); behavior is otherwise
 * identical to the prior middleware.
 *
 * ── Public allowlist (no auth at all) ───────────────────────────────────────
 * These leak nothing sensitive and must stay reachable without a session:
 *   /sign-in                       sign-in page
 *   /login                         stale-URL redirect stub → /sign-in
 *   /api/auth/*                    Better Auth handlers (sign-in/callback/…)
 *   /api/health                    liveness probe
 *   /field/install                 enterprise IPA install page (fresh phone)
 *   /api/field/manifest.plist      OTA manifest (presigned IPA URL, short-lived)
 *   /api/field/version             latest build number + install URL
 *
 * ── Bearer-only API (NOT cookie-gated) ──────────────────────────────────────
 * These routes enforce a BEARER device session themselves via
 * `resolveDeviceSession`; the phone carries an `Authorization: Bearer` token
 * and NO session cookie, so cookie-gating them would redirect the phone to
 * /sign-in and break sync. The proxy must let them through; the route returns
 * 401/403 itself on a missing/invalid bearer:
 *   /api/device/*                  register / credential / unlink
 *   /api/bol/upload-grant          BOL presigned-PUT grant
 *
 * ── Gated (require a session cookie) ─────────────────────────────────────────
 * Everything else, including:
 *   /tag/{epc}                     printed-label QR landing — now requires
 *                                  sign-in per operator instruction (warehouse
 *                                  staff all have Entra accounts). Earlier plans
 *                                  assumed public; the decision doc records the
 *                                  change so label QRs require sign-in on first
 *                                  scan.
 *   /link-device                   already requires a REAL session (it mints a
 *                                  one-time token against the session cookie);
 *                                  the cookie gate is the first line of defense.
 *   /, /requests, /warehouse, /admin/devices, …
 */

/** Exact paths that never require a session cookie. */
const PUBLIC_PATHS = new Set(["/sign-in", "/login", "/field/install"]);

/** Path prefixes that never require a session cookie. */
const PUBLIC_PREFIXES = [
  "/api/auth/",
  "/api/health",
  "/api/field/manifest.plist",
  "/api/field/version",
];

/**
 * Path prefixes whose routes enforce a BEARER device session themselves. The
 * proxy must NOT cookie-gate these — the phone is bearer-only (no cookie), so a
 * cookie gate would bounce it to /sign-in and break field sync.
 */
const BEARER_PREFIXES = ["/api/device/", "/api/bol/upload-grant"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isBearerOnly(pathname: string): boolean {
  return BEARER_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (isDevBypassActive() || isPublic(pathname) || isBearerOnly(pathname)) {
    return NextResponse.next();
  }
  const session = getSessionCookie(request);
  if (!session) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }
  return NextResponse.next();
}

/**
 * Run the proxy on every route EXCEPT Next internals and the public + bearer
 * paths above (the function re-checks the allowlist as a safety net, so a
 * matcher miss can't accidentally gate a public route). Excluding the public
 * paths from the matcher is a perf hint — the function is the source of truth.
 */
export const config = {
  matcher: [
    "/((?!api/auth/|api/health|api/device/|api/bol/upload-grant|api/field/manifest\\.plist|api/field/version|sign-in|login|field/install|_next/|favicon\\.ico).*)",
  ],
};
