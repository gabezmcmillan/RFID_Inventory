import { counts } from "@rfid/domain";

import { getDb } from "@/lib/db";

/** Liveness + DB reachability check. Public (excluded from auth in middleware). */
export async function GET(): Promise<Response> {
  try {
    const db = await getDb();
    // A lightweight domain aggregate doubles as a `SELECT 1` — and keeps all
    // SQL inside the domain package (the web app writes no SQL).
    await counts(db);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { ok: false, message: err instanceof Error ? err.message : "db error" },
      { status: 503 },
    );
  }
}
