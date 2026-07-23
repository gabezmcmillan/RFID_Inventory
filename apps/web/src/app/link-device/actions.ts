"use server";

import { headers } from "next/headers";

import { getAuth } from "@/lib/auth";

/**
 * Generate a fresh one-time device-linking token for the signed-in user.
 *
 * Server-side generation only (the task's security requirement): the token is
 * minted by Better Auth's `oneTimeToken` plugin against the caller's REAL
 * session cookie, so a client cannot forge one for an arbitrary user. It is
 * single-use (verify consumes it) and expires in 5 minutes (see `auth.ts`). The
 * QR encodes this token; the phone exchanges it at `/api/auth/one-time-token/verify`.
 *
 * Returns an empty string when no auth backend is configured (the offline gate)
 * OR when the caller has no real session (the page guards this and renders a
 * sign-in-required state instead of calling). Errors are caught and surfaced as
 * an empty string so a stale/expired session mid-page never throws an uncaught
 * `APIError` into the client — the caller simply sees no new code.
 */
export async function generateLinkCode(): Promise<string> {
  const auth = getAuth();
  if (auth === null) {
    return "";
  }
  try {
    const { token } = await auth.api.generateOneTimeToken({
      headers: await headers(),
    });
    return token;
  } catch {
    return "";
  }
}
