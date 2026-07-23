import { Kysely } from "kysely";
import { LibsqlDialect } from "kysely-libsql";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { envState, getSession, generateClientToken } = vi.hoisted(() => {
  const envState = {
    FIELD_OPERATOR_ALLOWLIST: "ops@acme.com",
    BLOB_READ_WRITE_TOKEN: "rw-tok",
  };
  return {
    envState,
    getSession: vi.fn(),
    generateClientToken: vi.fn(),
  };
});

vi.mock("@/lib/env", () => ({
  env: new Proxy(envState, {
    get: (t, p: string) => (p in t ? t[p as keyof typeof t] : undefined),
  }),
}));

vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getSession } }),
  buildAuthDialect: () => new LibsqlDialect({ url: ":memory:" }),
  isAuthEnabled: () => true,
  isMicrosoftEnabled: () => false,
}));

vi.mock("@vercel/blob/client", () => ({ generateClientTokenFromReadWriteToken: generateClientToken }));

import { __setAuthKyselyForTesting } from "@/lib/devices";
import { POST as register } from "@/app/api/device/register/route";
import { POST as unlinkRoute } from "@/app/api/device/unlink/route";
import { POST as grant } from "@/app/api/bol/upload-grant/route";

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
  return new Request("http://localhost/api/bol/upload-grant", init);
}

function noBearerReq(): Request {
  getSession.mockReset();
  return new Request("http://localhost/api/bol/upload-grant", { method: "POST" });
}

const VALID_BODY = {
  docId: "11111111-2222-3333-4444-555555555555",
  contentHash: "a".repeat(64),
  contentType: "image/jpeg",
  sizeBytes: 12345,
};

async function registerOk(): Promise<void> {
  const res = await register(bearerReq("ops@acme.com", {}));
  expect(res.status).toBe(200);
}

describe("BOL upload-grant endpoint", () => {
  beforeEach(() => {
    __setAuthKyselyForTesting(inMemoryAuthDb() as never, false);
    getSession.mockReset();
    generateClientToken.mockReset();
    generateClientToken.mockResolvedValue("client-tok");
  });
  afterEach(() => {
    __setAuthKyselyForTesting(null);
  });

  test("no bearer => 401", async () => {
    const res = await grant(noBearerReq());
    expect(res.status).toBe(401);
  });

  test("allowlist denial => 403", async () => {
    const res = await grant(bearerReq("eve@evil.com", VALID_BODY));
    expect(res.status).toBe(403);
  });

  test("no active device => 403", async () => {
    const res = await grant(bearerReq("ops@acme.com", VALID_BODY));
    expect(res.status).toBe(403);
  });

  test("active device mints a client token bound to the content-addressed pathname", async () => {
    await registerOk();
    const res = await grant(bearerReq("ops@acme.com", VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clientToken: string; pathname: string; access: string; expiresAt: number };
    expect(body.clientToken).toBe("client-tok");
    expect(body.access).toBe("private");
    expect(body.pathname).toBe(`bol/${VALID_BODY.docId}/${VALID_BODY.contentHash}.jpg`);
    expect(body.expiresAt).toBe(300);
    expect(generateClientToken).toHaveBeenCalledTimes(1);
    const arg = generateClientToken.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.pathname).toBe(body.pathname);
    expect(arg.addRandomSuffix).toBe(false);
    expect(arg.allowOverwrite).toBe(false);
    expect(arg.maximumSizeInBytes).toBe(25 * 1024 * 1024);
    expect(arg.allowedContentTypes).toEqual(["image/jpeg", "image/png", "application/pdf"]);
    expect(arg.token).toBe("rw-tok");
  });

  test("pdf content type maps to .pdf extension", async () => {
    await registerOk();
    const res = await grant(
      bearerReq("ops@acme.com", { ...VALID_BODY, contentType: "application/pdf", sizeBytes: 50000 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pathname: string };
    expect(body.pathname.endsWith(".pdf")).toBe(true);
  });

  test("denied after unlink => 403", async () => {
    await registerOk();
    await unlinkRoute(bearerReq("ops@acme.com"));
    const res = await grant(bearerReq("ops@acme.com", VALID_BODY));
    expect(res.status).toBe(403);
  });

  test("blob not configured => 503", async () => {
    const prev = envState.BLOB_READ_WRITE_TOKEN;
    envState.BLOB_READ_WRITE_TOKEN = "";
    try {
      await registerOk();
      const res = await grant(bearerReq("ops@acme.com", VALID_BODY));
      expect(res.status).toBe(503);
    } finally {
      envState.BLOB_READ_WRITE_TOKEN = prev;
    }
  });

  test("grant mint failure => 502", async () => {
    await registerOk();
    generateClientToken.mockRejectedValue(new Error("boom"));
    const res = await grant(bearerReq("ops@acme.com", VALID_BODY));
    expect(res.status).toBe(502);
  });

  test("invalid docId => 400", async () => {
    await registerOk();
    const res = await grant(bearerReq("ops@acme.com", { ...VALID_BODY, docId: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });

  test("invalid content hash => 400", async () => {
    await registerOk();
    const res = await grant(bearerReq("ops@acme.com", { ...VALID_BODY, contentHash: "xyz" }));
    expect(res.status).toBe(400);
  });

  test("disallowed content type => 400", async () => {
    await registerOk();
    const res = await grant(bearerReq("ops@acme.com", { ...VALID_BODY, contentType: "image/tiff" }));
    expect(res.status).toBe(400);
  });

  test("oversize body => 400", async () => {
    await registerOk();
    const res = await grant(
      bearerReq("ops@acme.com", { ...VALID_BODY, sizeBytes: 25 * 1024 * 1024 + 1 }),
    );
    expect(res.status).toBe(400);
  });

  test("malformed JSON => 400", async () => {
    await registerOk();
    getSession.mockResolvedValueOnce({
      session: { id: "sess-1" },
      user: { id: "user-1", email: "ops@acme.com", name: "Ops" },
    });
    const res = new Request("http://localhost/api/bol/upload-grant", {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
      body: "{not json",
    });
    const out = await grant(res);
    expect(out.status).toBe(400);
  });
});
