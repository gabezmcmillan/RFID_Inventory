"use server";

import { headers } from "next/headers";

import { getAuth } from "@/lib/auth";

/**
 * Generate a fresh one-time device-linking token for the signed-in user.
 *
 * Server-side generation only (the task's security requirement): the token is
 * minted by Better Auth's `oneTimeToken` plugin against the caller's session
 * cookie, so a client cannot forge one for an arbitrary user. It is single-use
 * (verify consumes it) and expires in 5 minutes (see `auth.ts`). The QR encodes
 * this token; the phone exchanges it at `/api/auth/one-time-token/verify`.
 *
 * Returns an empty string when no auth backend is configured (the offline gate)
 * — the page renders a notice instead of calling this.
 */
export async function generateLinkCode(): Promise<string> {
  const auth = getAuth();
  if (auth === null) {
    return "";
  }
  const { token } = await auth.api.generateOneTimeToken({
    headers: await headers(),
  });
  return token;
}
