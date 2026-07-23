import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Stub the domain `counts` (the health route's SELECT-1 stand-in) so a mocked
// db object is never actually queried.
vi.mock("@rfid/domain", () => ({ counts: vi.fn() }));
// Stub getDb so we can inject success/failure without a real database (and
// avoid loading @/lib/env / the Turso driver during the test).
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

// Capture console.error so the test stays quiet and we can assert it logged.
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import { GET as healthGet } from "@/app/api/health/route";
import { getDb } from "@/lib/db";

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    errorSpy.mockClear();
  });

  test("ok when the db check succeeds", async () => {
    vi.mocked(getDb).mockResolvedValue({} as never);
    const res = await healthGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("hides injected error detail behind a generic message (503)", async () => {
    // A deliberately leaky internal error — must NOT reach the response body.
    vi.mocked(getDb).mockRejectedValue(
      new Error("SQLITE_AUTH: libsql://rfid-warehouse-vercel-icfg-x.turso.io token=sekret_xyz"),
    );
    const res = await healthGet();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toBe("service unavailable");
    // The raw driver/host/token detail must not be echoed to the caller.
    expect(JSON.stringify(body)).not.toContain("sekret_xyz");
    expect(JSON.stringify(body)).not.toContain("libsql://");
    // ...but it IS logged server-side for operators.
    expect(errorSpy).toHaveBeenCalled();
  });
});
