import { describe, expect, it, vi } from "vitest";
import { ServerBolGrantProvider } from "../bolGrantProvider";

const REQ = {
  docId: "11111111-2222-3333-4444-555555555555",
  contentHash: "a".repeat(64),
  contentType: "image/jpeg",
  sizeBytes: 123,
};

describe("ServerBolGrantProvider (server proxy grant)", () => {
  it("returns a PUT grant to the server proxy with bearer + content-addressed headers (no network call)", async () => {
    const provider = new ServerBolGrantProvider({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      getServerUrl: async () => "https://api.example",
      getBearer: async () => "bearer-tok",
    });
    const grant = await provider.getUploadGrant(REQ);
    expect(grant.method).toBe("PUT");
    expect(grant.uploadUrl).toBe("https://api.example/api/bol/upload");
    expect(grant.headers?.authorization).toBe("Bearer bearer-tok");
    expect(grant.headers?.["x-bol-doc-id"]).toBe(REQ.docId);
    expect(grant.headers?.["x-bol-content-hash"]).toBe(REQ.contentHash);
    expect(grant.headers?.["x-bol-content-type"]).toBe("image/jpeg");
  });

  it("throws a no-status error when unlinked (no bearer) — queue records network", async () => {
    const provider = new ServerBolGrantProvider({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      getServerUrl: async () => "https://api.example",
      getBearer: async () => null,
    });
    await expect(provider.getUploadGrant(REQ)).rejects.toThrow(/no linked device bearer/);
  });
});
