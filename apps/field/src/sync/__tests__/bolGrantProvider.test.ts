import { describe, expect, it, vi } from "vitest";
import { ServerBolGrantProvider } from "../bolGrantProvider";

const REQ = {
  docId: "11111111-2222-3333-4444-555555555555",
  contentHash: "a".repeat(64),
  contentType: "image/jpeg",
  sizeBytes: 123,
};

function fakeFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  let responder: () => Response = () =>
    new Response(
      JSON.stringify({
        presignedUrl: "https://store_x.private.blob.vercel-storage.com/bol/d/x.jpg?sig=abc",
        storageUrl: "https://store_x.private.blob.vercel-storage.com/bol/d/x.jpg",
        contentType: "image/jpeg",
      }),
      { status: 200 },
    );
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responder();
  });
  return { fn, calls, setResponder: (r: () => Response) => (responder = r) };
}

describe("ServerBolGrantProvider (presigned PUT grant)", () => {
  it("POSTs to the grant endpoint with bearer + artifact fields and returns a presigned-PUT grant", async () => {
    const fetchMock = fakeFetch();
    const provider = new ServerBolGrantProvider({
      fetchImpl: fetchMock.fn as unknown as typeof fetch,
      getServerUrl: async () => "https://api.example",
      getBearer: async () => "bearer-tok",
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
    expect(grant.uploadUrl).toBe(
      "https://store_x.private.blob.vercel-storage.com/bol/d/x.jpg?sig=abc",
    );
    expect(grant.headers?.["content-type"]).toBe("image/jpeg");
    expect(grant.storageUrl).toBe(
      "https://store_x.private.blob.vercel-storage.com/bol/d/x.jpg",
    );
  });

  it("throws a no-status error when unlinked (no bearer) — queue records network", async () => {
    const fetchMock = fakeFetch();
    const provider = new ServerBolGrantProvider({
      fetchImpl: fetchMock.fn as unknown as typeof fetch,
      getServerUrl: async () => "https://api.example",
      getBearer: async () => null,
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
    });
    await expect(provider.getUploadGrant(REQ)).rejects.toThrow(/network failure/);
  });

  it("throws when the grant response is missing fields", async () => {
    const fetchMock = fakeFetch();
    fetchMock.setResponder(
      () => new Response(JSON.stringify({ presignedUrl: "x", storageUrl: "", contentType: "" }), { status: 200 }),
    );
    const provider = new ServerBolGrantProvider({
      fetchImpl: fetchMock.fn as unknown as typeof fetch,
      getServerUrl: async () => "https://api.example",
      getBearer: async () => "bearer-tok",
    });
    await expect(provider.getUploadGrant(REQ)).rejects.toThrow(/missing fields/);
  });
});
