import { describe, expect, it, vi } from "vitest";
import { ServerBolGrantProvider } from "../bolGrantProvider";

const CLIENT_TOKEN = "vercel_blob_client_store_ABC123_def456";

function fakeFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  let responder: () => Response = () =>
    new Response(
      JSON.stringify({ clientToken: CLIENT_TOKEN, pathname: "bol/d1/x.jpg", access: "private", expiresAt: 300 }),
      { status: 200 },
    );
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responder();
  });
  return { fn, calls, setResponder: (r: () => Response) => (responder = r) };
}

const REQ = { docId: "11111111-2222-3333-4444-555555555555", contentHash: "a".repeat(64), contentType: "image/jpeg", sizeBytes: 123 };

describe("ServerBolGrantProvider", () => {
  it("POSTs to the grant endpoint with the bearer + artifact fields and returns a PUT grant", async () => {
    const fetchMock = fakeFetch();
    const provider = new ServerBolGrantProvider({
      fetchImpl: fetchMock.fn as unknown as typeof fetch,
      getServerUrl: async () => "https://api.example",
      getBearer: async () => "bearer-tok",
      now: () => 1_000,
      rand: () => 0.5,
    });
    const grant = await provider.getUploadGrant(REQ);
    expect(fetchMock.calls[0].url).toBe("https://api.example/api/bol/upload-grant");
    const headers = fetchMock.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer bearer-tok");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(fetchMock.calls[0].init.body as string)).toEqual({
      docId: REQ.docId,
      contentHash: REQ.contentHash,
      contentType: REQ.contentType,
      sizeBytes: REQ.sizeBytes,
    });
    expect(grant.method).toBe("PUT");
    expect(grant.headers?.authorization).toBe(`Bearer ${CLIENT_TOKEN}`);
    expect(grant.headers?.["x-vercel-blob-store-id"]).toBe("store");
  });

  it("throws a no-status error when unlinked (no bearer) — queue records network", async () => {
    const fetchMock = fakeFetch();
    const provider = new ServerBolGrantProvider({
      fetchImpl: fetchMock.fn as unknown as typeof fetch,
      getServerUrl: async () => "https://api.example",
      getBearer: async () => null,
      now: () => 0,
      rand: () => 0,
    });
    await expect(provider.getUploadGrant(REQ)).rejects.toThrow(/no linked device bearer/);
    expect(fetchMock.calls.length).toBe(0);
  });

  it("throws a status error on a non-OK response — queue records http", async () => {
    const fetchMock = fakeFetch();
    fetchMock.setResponder(() => new Response("nope", { status: 503 }));
    const provider = new ServerBolGrantProvider({
      fetchImpl: fetchMock.fn as unknown as typeof fetch,
      getServerUrl: async () => "https://api.example",
      getBearer: async () => "bearer-tok",
      now: () => 0,
      rand: () => 0,
    });
    try {
      await provider.getUploadGrant(REQ);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error & { status?: number }).status).toBe(503);
    }
  });

  it("throws a no-status error on a network failure", async () => {
    const fetchMock = fakeFetch();
    fetchMock.fn.mockRejectedValueOnce(new Error("offline"));
    const provider = new ServerBolGrantProvider({
      fetchImpl: fetchMock.fn as unknown as typeof fetch,
      getServerUrl: async () => "https://api.example",
      getBearer: async () => "bearer-tok",
      now: () => 0,
      rand: () => 0,
    });
    await expect(provider.getUploadGrant(REQ)).rejects.toThrow(/network failure/);
  });
});
