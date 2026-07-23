import { counts } from "@rfid/domain";

import { getDb } from "@/lib/db";

/**
 * Liveness + DB reachability check. Public (excluded from auth in middleware).
 *
 * Returns a generic status only — never the raw exception text (plan 010
 * Phase 4.3), so an internal error doesn't leak driver/host details to an
 * unauthenticated caller. The detail is logged server-side instead.
 */
export async function GET(): Promise<Response> {
  try {
    const db = await getDb();
    // A lightweight domain aggregate doubles as a `SELECT 1` — and keeps all
    // SQL inside the domain package (the web app writes no SQL).
    await counts(db);
    return Response.json({ ok: true });
  } catch (err) {
    // Log the real cause server-side; surface only a generic message.
    console.error("[health] db check failed:", err instanceof Error ? err.message : err);
    return Response.json({ ok: false, message: "service unavailable" }, { status: 503 });
  }
}
