import { describe, expect, test, vi } from "vitest";

const { getSession, listDevices } = vi.hoisted(() => ({
  getSession: vi.fn(),
  listDevices: vi.fn(),
}));

// Minimal env stub (the route's transitive imports read it; we mock auth/devices
// so the real env values are never used).
vi.mock("@/lib/env", () => ({
  env: new Proxy(
    {},
    { get: () => undefined },
  ),
}));
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getSession } }),
  buildAuthDialect: () => ({ createTable: () => {} }),
  isAuthEnabled: () => true,
  isMicrosoftEnabled: () => false,
}));
vi.mock("@/lib/devices", () => ({
  listDevicesWithLinker: listDevices,
}));

import { GET } from "@/app/api/admin/devices/route";

function authedReq(): Request {
  getSession.mockResolvedValueOnce({
    session: { id: "sess-1" },
    user: { id: "user-1", email: "ops@acme.com", name: "Ops" },
  });
  return new Request("http://localhost/api/admin/devices", { method: "GET" });
}

function unauthedReq(): Request {
  getSession.mockResolvedValueOnce(null);
  return new Request("http://localhost/api/admin/devices", { method: "GET" });
}

describe("GET /api/admin/devices", () => {
  test("authenticated: returns the device list as JSON", async () => {
    listDevices.mockResolvedValueOnce([
      { id: "dev-1", epc_byte: "00", active: 1, label: "Scanner 1" },
    ]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("dev-1");
  });

  test("unauthenticated: 401", async () => {
    const res = await GET(unauthedReq());
    expect(res.status).toBe(401);
  });
});
