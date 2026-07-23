/**
 * `GET /api/admin/devices` — the read endpoint the admin Devices page's
 * TanStack Query `queryFn` fetches for refetches / window-focus revalidation.
 *
 * This is the documented App-Router pattern: Server Components prefetch the
 * list directly from `listDevicesWithLinker()` (server DB) and dehydrate it;
 * the client `useQuery` re-fetches through this route handler on invalidation
 * or focus. Server Actions remain the mutation path (no API redesign) — see
 * `apps/web/src/app/admin/devices/actions.ts`.
 *
 * Auth: the proxy (`src/proxy.ts`) cookie-gates this route (it is not on the
 * public or bearer-only allowlist), and the route re-checks the session
 * in-route for defense in depth. A missing/invalid session returns 401 (the
 * query surfaces an error state rather than silently redirecting).
 */

import { getAuth } from "@/lib/auth";
import { listDevicesWithLinker, type DeviceWithLinker } from "@/lib/devices";

// Reads the auth DB at request time; never prerendered.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = getAuth();
  if (auth === null) {
    return Response.json({ error: "Auth is not configured" }, { status: 503 });
  }
  // Read the session from the incoming request's headers (the cookie lives
  // here) rather than `next/headers`, so the handler is testable without a
  // Next request scope.
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const devices: DeviceWithLinker[] = await listDevicesWithLinker();
  return Response.json(devices);
}
