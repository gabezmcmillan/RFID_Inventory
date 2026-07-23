import { Kysely } from "kysely";
import { LibsqlDialect } from "kysely-libsql";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { envState, getSession, issueGrant } = vi.hoisted(() => {
  const envState = {
    FIELD_OPERATOR_ALLOWLIST: "ops@acme.com",
    BLOB_READ_WRITE_TOKEN: "rw-tok",
  };
  return {
    envState,
    getSession: vi.fn(),
    issueGrant: vi.fn(),
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

vi.mock("@/lib/bolBlob", () => ({
  ALLOWED_BOL_CONTENT_TYPES: ["image/jpeg", "image/png", "application/pdf"],
  CONTENT_HASH_RE: /^[0-9a-f]{64}$/,
  DOC_ID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  MAX_BOL_BYTES: 25 * 1024 * 1024,
  issueBolPutGrant: issueGrant,
}));

import { __setAuthKyselyForTesting } from "@/lib/devices";
import { POST as register } from "@/app/api/device/register/route";
import { POST as unlinkRoute } from "@/app/api/device/unlink/route";
import { POST as grantRoute } from "@/app/api/bol/upload-grant/route";

function inMemoryAuthDb(): Kysely<unknown> {
  return new Kysely({ dialect: new LibsqlDialect({ url: ":memory:" }) });
}

const DOC_ID = "11111111-2222-3333-4444-555555555555";
const HASH = "a".repeat(64);

function grantReq(email: string, body: Record<string, unknown>): Request {
  getSession.mockResolvedValueOnce({
    session: { id: "sess-1" },
    user: { id: "user-1", email, name: "Ops" },
  });
  return new Request("http://localhost/api/bol/upload-grant", {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function noBearerReq(): Request {
  getSession.mockReset();
  return new Request("http://localhost/api/bol/upload-grant", { method: "POST" });
}

async function registerOk(): Promise<void> {
  const res = await register(
    (() => {
      getSession.mockResolvedValueOnce({
        session: { id: "sess-1" },
        user: { id: "user-1", email: "ops@acme.com", name: "Ops" },
      });
      return new Request("http://localhost/api/device/register", {
        method: "POST",
        headers: { Authorization: "Bearer t" },
      });
    })(),
  );
  expect(res.status).toBe(200);
}

const GOOD_BODY = { docId: DOC_ID, contentHash: HASH, contentType: "image/jpeg", sizeBytes: 123 };

describe("BOL upload grant (POST /api/bol/upload-grant)", () => {
  beforeEach(() => {
    __setAuthKyselyForTesting(inMemoryAuthDb() as never, false);
    getSession.mockReset();
    issueGrant.mockReset();
    issueGrant.mockResolvedValue({
      presignedUrl: "https://store_x.private.blob.vercel-storage.com/bol/d/x.jpg?sig=abc",
      storageUrl: "https://store_x.private.blob.vercel-storage.com/bol/d/x.jpg",
      contentType: "image/jpeg",
    });
  });
  afterEach(() => {
    __setAuthKyselyForTesting(null);
  });

  test("no bearer => 401", async () => {
    const res = await grantRoute(noBearerReq());
    expect(res.status).toBe(401);
  });

  test("allowlist denial => 403", async () => {
    const res = await grantRoute(grantReq("eve@evil.com", GOOD_BODY));
    expect(res.status).toBe(403);
  });

  test("no active device => 403", async () => {
    const res = await grantRoute(grantReq("ops@acme.com", GOOD_BODY));
    expect(res.status).toBe(403);
  });

  test("blob not configured => 503", async () => {
    const prev = envState.BLOB_READ_WRITE_TOKEN;
    envState.BLOB_READ_WRITE_TOKEN = "";
    try {
      await registerOk();
      const res = await grantRoute(grantReq("ops@acme.com", GOOD_BODY));
      expect(res.status).toBe(503);
    } finally {
      envState.BLOB_READ_WRITE_TOKEN = prev;
    }
  });

  test("active device => 200 with presigned PUT grant + private storageUrl", async () => {
    await registerOk();
    const res = await grantRoute(grantReq("ops@acme.com", GOOD_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      presignedUrl: string;
      storageUrl: string;
      contentType: string;
    };
    expect(body.presignedUrl).toBe(
      "https://store_x.private.blob.vercel-storage.com/bol/d/x.jpg?sig=abc",
    );
    expect(body.storageUrl).toBe(
      "https://store_x.private.blob.vercel-storage.com/bol/d/x.jpg",
    );
    expect(body.contentType).toBe("image/jpeg");
    expect(issueGrant).toHaveBeenCalledTimes(1);
    expect(issueGrant.mock.calls[0]![0]).toEqual(GOOD_BODY);
  });

  test("pdf content type is accepted", async () => {
    await registerOk();
    const res = await grantRoute(
      grantReq("ops@acme.com", { ...GOOD_BODY, contentType: "application/pdf" }),
    );
    expect(res.status).toBe(200);
    expect(issueGrant.mock.calls[0]![0].contentType).toBe("application/pdf");
  });

  test("denied after unlink => 403", async () => {
    await registerOk();
    await unlinkRoute(
      (() => {
        getSession.mockResolvedValueOnce({
          session: { id: "sess-1" },
          user: { id: "user-1", email: "ops@acme.com", name: "Ops" },
        });
        return new Request("http://localhost/api/device/unlink", {
          method: "POST",
          headers: { Authorization: "Bearer t" },
        });
      })(),
    );
    const res = await grantRoute(grantReq("ops@acme.com", GOOD_BODY));
    expect(res.status).toBe(403);
  });

  test("invalid docId => 400", async () => {
    await registerOk();
    const res = await grantRoute(
      grantReq("ops@acme.com", { ...GOOD_BODY, docId: "not-a-uuid" }),
    );
    expect(res.status).toBe(400);
    expect(issueGrant).not.toHaveBeenCalled();
  });

  test("invalid content hash => 400", async () => {
    await registerOk();
    const res = await grantRoute(
      grantReq("ops@acme.com", { ...GOOD_BODY, contentHash: "xyz" }),
    );
    expect(res.status).toBe(400);
  });

  test("disallowed content type => 400", async () => {
    await registerOk();
    const res = await grantRoute(
      grantReq("ops@acme.com", { ...GOOD_BODY, contentType: "image/tiff" }),
    );
    expect(res.status).toBe(400);
  });

  test("non-positive sizeBytes => 400", async () => {
    await registerOk();
    const res = await grantRoute(
      grantReq("ops@acme.com", { ...GOOD_BODY, sizeBytes: 0 }),
    );
    expect(res.status).toBe(400);
  });

  test("oversize sizeBytes => 400 (rejected before minting)", async () => {
    await registerOk();
    const res = await grantRoute(
      grantReq("ops@acme.com", { ...GOOD_BODY, sizeBytes: 25 * 1024 * 1024 + 1 }),
    );
    expect(res.status).toBe(400);
    expect(issueGrant).not.toHaveBeenCalled();
  });

  test("invalid JSON body => 400", async () => {
    await registerOk();
    getSession.mockResolvedValueOnce({
      session: { id: "sess-1" },
      user: { id: "user-1", email: "ops@acme.com", name: "Ops" },
    });
    const req = new Request("http://localhost/api/bol/upload-grant", {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await grantRoute(req);
    expect(res.status).toBe(400);
  });

  test("grant mint failure => 502", async () => {
    await registerOk();
    issueGrant.mockRejectedValue(new Error("boom"));
    const res = await grantRoute(grantReq("ops@acme.com", GOOD_BODY));
    expect(res.status).toBe(502);
  });
});
