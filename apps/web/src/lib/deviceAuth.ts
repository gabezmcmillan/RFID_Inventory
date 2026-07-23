/**
 * Bearer-session resolution for the field-device API (plan 010, Phase 2). The
 * phone authenticates with `Authorization: Bearer <session.token>` (Better
 * Auth's `bearer` plugin converts it to a session in-flight). These helpers
 * resolve the session/user from a request and produce typed 401/403 responses
 * so the route handlers stay thin.
 */

import type { AuthInstance } from "@/lib/auth";

export interface DeviceSession {
  /** Better Auth session id (stored on the `field_devices` row for revocation). */
  sessionId: string;
  userId: string;
  email: string;
  name: string | null;
}

/** Resolve the bearer session from a request, or `null` if unauthenticated. */
export async function resolveDeviceSession(
  auth: AuthInstance,
  request: Request,
): Promise<DeviceSession | null> {
  if (auth === null) return null;
  const result = await auth.api.getSession({ headers: request.headers });
  if (!result) return null;
  const { session, user } = result;
  return {
    sessionId: session.id,
    userId: user.id,
    email: user.email,
    name: user.name ?? null,
  };
}

/** JSON response helper. */
export function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/** A 401 response (no/invalid bearer). */
export function unauthorized(message = "Unauthorized"): Response {
  return json({ error: message }, 401);
}

/** A 403 response (authenticated but not permitted — e.g. not on the allowlist). */
export function forbidden(message = "Forbidden"): Response {
  return json({ error: message }, 403);
}
