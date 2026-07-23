import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "kysely-libsql";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// vi.mock factories are hoisted above top-level lets, so the shared state they
// close over must be created with vi.hoisted (which runs before the mocks).
const { envState, getSession, mintSyncToken } = vi.hoisted(() => {
  const envState = {
    FIELD_OPERATOR_ALLOWLIST: "ops@acme.com",
    TURSO_MINT_TOKEN: "plat-tok",
    TURSO_ORG: "vercel",
    TURSO_DB_NAME: "rfid-warehouse",
    TURSO_DATABASE_URL: "libsql://rfid-warehouse-vercel-icfg-x.turso.io",
  };
  return { envState, getSession: vi.fn(), mintSyncToken: vi.fn() };
});

// Stub env BEFORE the endpoint modules import it: control the allowlist + mint
// config without touching process.env at import time.
vi.mock("@/lib/env", () => ({
  env: new Proxy(envState, {
    get: (t, p: string) => (p in t ? t[p as keyof typeof t] : undefined),
  }),
}));

// Fake Better Auth: only `api.getSession` is exercised by the device routes.
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getSession } }),
  buildAuthDialect: () => new LibsqlDialect({ url: ":memory:" }),
  isAuthEnabled: () => true,
  isMicrosoftEnabled: () => false,
}));

// Avoid real network calls during the mint.
mintSyncToken.mockResolvedValue({ jwt: "sync-jwt" });
vi.mock("@/lib/tursoMint", () => ({ mintSyncToken }));

import { __setAuthKyselyForTesting, deactivateDevice, reactivateDevice, unlinkDevice as unlinkDeviceRepo } from "@/lib/devices";
import { POST as register } from "@/app/api/device/register/route";
import { POST as credential } from "@/app/api/device/credential/route";
import { POST as unlinkRoute } from "@/app/api/device/unlink/route";

function inMemoryAuthDb(): Kysely<unknown> {
  return new Kysely({ dialect: new LibsqlDialect({ url: ":memory:" }) });
}

function bearerReq(email: string, body?: unknown): Request {
  getSession.mockResolvedValueOnce({
    session: { id: "sess-1" },
    user: { id: "user-1", email, name: "Ops" },
  });
  const headers: Record<string, string> = { Authorization: "Bearer t" };
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request("http://localhost/api/device/x", init);
}

function noBearerReq(): Request {
  getSession.mockReset();
  return new Request("http://localhost/api/device/x", { method: "POST" });
}

async function registerOk(): Promise<{ deviceId: string; epcByte: string }> {
  const res = await register(bearerReq("ops@acme.com", {}));
  expect(res.status).toBe(200);
  return (await res.json()) as { deviceId: string; epcByte: string };
}

describe("device endpoints — credential control", () => {
  let k: Kysely<unknown>;
  beforeEach(() => {
    k = inMemoryAuthDb();
    __setAuthKyselyForTesting(k as never, false);
    getSession.mockReset();
    mintSyncToken.mockClear();
  });
  afterEach(() => {
    __setAuthKyselyForTesting(null);
  });

  test("register: no bearer => 401", async () => {
    const res = await register(noBearerReq());
    expect(res.status).toBe(401);
  });

  test("register: allowlist denial (email not on the list) => 403", async () => {
    const res = await register(bearerReq("eve@evil.com", {}));
    expect(res.status).toBe(403);
  });

  test("register: allowlisted user gets a device id + permanent EPC byte", async () => {
    const dev = await registerOk();
    expect(dev.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(dev.epcByte).toBe("00");
  });

  test("register: a second active device for the same user => 409 (unlink first)", async () => {
    await registerOk();
    const res = await register(bearerReq("ops@acme.com", {}));
    expect(res.status).toBe(409);
  });

  test("credential: no bearer => 401", async () => {
    const res = await credential(noBearerReq());
    expect(res.status).toBe(401);
  });

  test("credential: allowlist denial => 403", async () => {
    const res = await credential(bearerReq("eve@evil.com"));
    expect(res.status).toBe(403);
  });

  test("credential: active device mints a short-lived sync token", async () => {
    await registerOk();
    const res = await credential(bearerReq("ops@acme.com"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: number; url: string };
    expect(body.token).toBe("sync-jwt");
    expect(body.url).toBe("libsql://rfid-warehouse-vercel-icfg-x.turso.io");
    expect(mintSyncToken).toHaveBeenCalledTimes(1);
  });

  test("refresh denial after unlink: credential => 403 (no active device)", async () => {
    await registerOk();
    // Unlink via the unlink endpoint (revokes the device + session).
    const unlinkRes = await unlinkRoute(bearerReq("ops@acme.com"));
    expect(unlinkRes.status).toBe(200);
    // A subsequent credential request is denied — the device is inactive.
    const res = await credential(bearerReq("ops@acme.com"));
    expect(res.status).toBe(403);
  });

  test("refresh denial after revoke: credential => 403", async () => {
    const dev = await registerOk();
    // Operator revokes the device directly (lost-device path).
    await unlinkDeviceRepo(dev.deviceId);
    const res = await credential(bearerReq("ops@acme.com"));
    expect(res.status).toBe(403);
  });

  test("deactivate blocks credential refresh (403) within the token TTL; reactivate restores it", async () => {
    const dev = await registerOk();
    // Soft-deactivate (operator pause): active=0, session kept.
    expect(await deactivateDevice(dev.deviceId)).toBe(true);
    const denied = await credential(bearerReq("ops@acme.com"));
    expect(denied.status).toBe(403); // pushes stop — no active device
    // Reactivate flips the device back on; the kept session means no re-link.
    expect(await reactivateDevice(dev.deviceId)).toBe(true);
    const ok = await credential(bearerReq("ops@acme.com"));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { token: string };
    expect(body.token).toBe("sync-jwt");
  });

  test("credential: mint not configured (no TURSO_MINT_TOKEN) => 503", async () => {
    const prev = envState.TURSO_MINT_TOKEN;
    envState.TURSO_MINT_TOKEN = "";
    try {
      await registerOk();
      const res = await credential(bearerReq("ops@acme.com"));
      expect(res.status).toBe(503);
    } finally {
      envState.TURSO_MINT_TOKEN = prev;
    }
  });
});
