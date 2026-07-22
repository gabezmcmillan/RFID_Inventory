/**
 * Session helper: returns the signed-in user for prefilling the checkout form,
 * or null. Step 4 wires this to Auth.js (Microsoft Entra ID) with an
 * `AUTH_DEV_BYPASS` fake-session guard for local dev. Kept in `lib/` so server
 * components and server actions share one code path.
 */

export interface SessionUser {
  name: string;
  email: string;
}

// Replaced by the Auth.js implementation in plan 009 step 4.
export async function getUser(): Promise<SessionUser | null> {
  return null;
}
