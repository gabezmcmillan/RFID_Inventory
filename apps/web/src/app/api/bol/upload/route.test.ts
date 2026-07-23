import { Kysely } from "kysely";
import { LibsqlDialect } from "kysely-libsql";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { envState, getSession, putBlob } = vi.hoisted(() => {
  const envState = {
    FIELD_OPERATOR_ALLOWLIST: "ops@acme.com",
    BLOB_READ_WRITE_TOKEN: "rw-tok",
  };
  return {
    envState,
    getSession: vi.fn(),
    putBlob: vi.fn(),
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

vi.mock("@vercel/blob", () => ({ put: putBlob }));

import { __setAuthKyselyForTesting } from "@/lib/devices";
import { POST as register } from "@/app/api/device/register/route";
import { POST as unlinkRoute } from "@/app/api/device/unlink/route";
import { PUT as upload, MAX_BOL_BYTES } from "@/app/api/bol/upload/route";

function inMemoryAuthDb(): Kysely<unknown> {
  return new Kysely({ dialect: new LibsqlDialect({ url: ":memory:" }) });
}

const DOC_ID = "11111111-2222-3333-4444-555555555555";
const HASH = "a".repeat(64);

function bearerReq(email: string, body: ArrayBuffer | null, contentType = "image/jpeg"): Request {
  getSession.mockResolvedValueOnce({
    session: { id: "sess-1" },
    user: { id: "user-1", email, name: "Ops" },
  });
  const headers: Record<string, string> = {
    Authorization: "Bearer t",
    "x-bol-doc-id": DOC_ID,
    "x-bol-content-hash": HASH,
    "x-bol-content-type": contentType,
  };
  const init: RequestInit = { method: "PUT", headers };
  if (body) {
    init.body = body;
    headers["content-length"] = String(body.byteLength);
  }
  return new Request("http://localhost/api/bol/upload", init);
}

function noBearerReq(): Request {
  getSession.mockReset();
  return new Request("http://localhost/api/bol/upload", { method: "PUT" });
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

describe("BOL upload proxy (PUT /api/bol/upload)", () => {
  beforeEach(() => {
    __setAuthKyselyForTesting(inMemoryAuthDb() as never, false);
    getSession.mockReset();
    putBlob.mockReset();
    putBlob.mockResolvedValue({ url: "https://blob.example/bol.jpg" });
  });
  afterEach(() => {
    __setAuthKyselyForTesting(null);
  });

  test("no bearer => 401", async () => {
    const res = await upload(noBearerReq());
    expect(res.status).toBe(401);
  });

  test("allowlist denial => 403", async () => {
    const res = await upload(bearerReq("eve@evil.com", new ArrayBuffer(10)));
    expect(res.status).toBe(403);
  });

  test("no active device => 403", async () => {
    const res = await upload(bearerReq("ops@acme.com", new ArrayBuffer(10)));
    expect(res.status).toBe(403);
  });

  test("blob not configured => 503", async () => {
    const prev = envState.BLOB_READ_WRITE_TOKEN;
    envState.BLOB_READ_WRITE_TOKEN = "";
    try {
      await registerOk();
      const res = await upload(bearerReq("ops@acme.com", new ArrayBuffer(10)));
      expect(res.status).toBe(503);
    } finally {
      envState.BLOB_READ_WRITE_TOKEN = prev;
    }
  });

  test("active device uploads via the server SDK to a content-addressed public pathname", async () => {
    await registerOk();
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const res = await upload(bearerReq("ops@acme.com", bytes));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toBe("https://blob.example/bol.jpg");
    expect(putBlob).toHaveBeenCalledTimes(1);
    const [pathname, bodyArg, opts] = putBlob.mock.calls[0]!;
    expect(pathname).toBe(`bol/${DOC_ID}/${HASH}.jpg`);
    expect(bodyArg).toBeInstanceOf(ArrayBuffer);
    expect(opts).toMatchObject({
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "image/jpeg",
      token: "rw-tok",
    });
  });

  test("pdf content type maps to .pdf extension", async () => {
    await registerOk();
    const res = await upload(
      bearerReq("ops@acme.com", new ArrayBuffer(10), "application/pdf"),
    );
    expect(res.status).toBe(200);
    const [pathname] = putBlob.mock.calls[0]!;
    expect(pathname.endsWith(".pdf")).toBe(true);
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
    const res = await upload(bearerReq("ops@acme.com", new ArrayBuffer(10)));
    expect(res.status).toBe(403);
  });

  test("invalid docId => 400", async () => {
    await registerOk();
    getSession.mockResolvedValueOnce({
      session: { id: "sess-1" },
      user: { id: "user-1", email: "ops@acme.com", name: "Ops" },
    });
    const req = new Request("http://localhost/api/bol/upload", {
      method: "PUT",
      headers: {
        Authorization: "Bearer t",
        "x-bol-doc-id": "not-a-uuid",
        "x-bol-content-hash": HASH,
        "x-bol-content-type": "image/jpeg",
      },
      body: new ArrayBuffer(10),
    });
    const res = await upload(req);
    expect(res.status).toBe(400);
  });

  test("invalid content hash => 400", async () => {
    await registerOk();
    getSession.mockResolvedValueOnce({
      session: { id: "sess-1" },
      user: { id: "user-1", email: "ops@acme.com", name: "Ops" },
    });
    const req = new Request("http://localhost/api/bol/upload", {
      method: "PUT",
      headers: {
        Authorization: "Bearer t",
        "x-bol-doc-id": DOC_ID,
        "x-bol-content-hash": "xyz",
        "x-bol-content-type": "image/jpeg",
      },
      body: new ArrayBuffer(10),
    });
    const res = await upload(req);
    expect(res.status).toBe(400);
  });

  test("disallowed content type => 400", async () => {
    await registerOk();
    getSession.mockResolvedValueOnce({
      session: { id: "sess-1" },
      user: { id: "user-1", email: "ops@acme.com", name: "Ops" },
    });
    const req = new Request("http://localhost/api/bol/upload", {
      method: "PUT",
      headers: {
        Authorization: "Bearer t",
        "x-bol-doc-id": DOC_ID,
        "x-bol-content-hash": HASH,
        "x-bol-content-type": "image/tiff",
      },
      body: new ArrayBuffer(10),
    });
    const res = await upload(req);
    expect(res.status).toBe(400);
  });

  test("oversize declared content-length => 413", async () => {
    await registerOk();
    getSession.mockResolvedValueOnce({
      session: { id: "sess-1" },
      user: { id: "user-1", email: "ops@acme.com", name: "Ops" },
    });
    const req = new Request("http://localhost/api/bol/upload", {
      method: "PUT",
      headers: {
        Authorization: "Bearer t",
        "x-bol-doc-id": DOC_ID,
        "x-bol-content-hash": HASH,
        "x-bol-content-type": "image/jpeg",
        "content-length": String(MAX_BOL_BYTES + 1),
      },
      body: new ArrayBuffer(10),
    });
    const res = await upload(req);
    expect(res.status).toBe(413);
    expect(putBlob).not.toHaveBeenCalled();
  });

  test("empty body => 400", async () => {
    await registerOk();
    const res = await upload(bearerReq("ops@acme.com", new ArrayBuffer(0)));
    expect(res.status).toBe(400);
  });

  test("put() failure => 502", async () => {
    await registerOk();
    putBlob.mockRejectedValue(new Error("boom"));
    const res = await upload(bearerReq("ops@acme.com", new ArrayBuffer(10)));
    expect(res.status).toBe(502);
  });
});
