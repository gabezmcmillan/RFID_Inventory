import { sql } from "drizzle-orm";

import { getDb } from "@/lib/db";

/** Liveness + DB reachability check. Public (excluded from auth in middleware). */
export async function GET(): Promise<Response> {
  try {
    const db = await getDb();
    await db.all<{ one: number }>(sql`SELECT 1 AS one`);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { ok: false, message: err instanceof Error ? err.message : "db error" },
      { status: 503 },
    );
  }
}
