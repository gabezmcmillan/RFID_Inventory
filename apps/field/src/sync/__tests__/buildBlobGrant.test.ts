import { describe, expect, it } from "vitest";
import { buildBlobGrant, parseStoreId } from "../buildBlobGrant";

const CLIENT_TOKEN = "vercel_blob_client_store_ABC123_def456";

describe("parseStoreId", () => {
  it("extracts the 4th underscore segment of a client token", () => {
    expect(parseStoreId(CLIENT_TOKEN)).toBe("store");
  });

  it("throws when the token has no store id segment", () => {
    expect(() => parseStoreId("vercel_blob_client_")).toThrow(/missing store id/);
  });
});

describe("buildBlobGrant", () => {
  it("builds a PUT grant to the Blob control API with the client token + store id headers", () => {
    const grant = buildBlobGrant(
      { clientToken: CLIENT_TOKEN, pathname: "bol/d1/" + "a".repeat(64) + ".jpg", access: "private", contentType: "image/jpeg" },
      { now: 1_000, rand: () => 0.5 },
    );
    expect(grant.method).toBe("PUT");
    expect(grant.uploadUrl).toBe(
      "https://vercel.com/api/blob/?pathname=" + encodeURIComponent("bol/d1/" + "a".repeat(64) + ".jpg"),
    );
    expect(grant.headers?.authorization).toBe(`Bearer ${CLIENT_TOKEN}`);
    expect(grant.headers?.["x-vercel-blob-store-id"]).toBe("store");
    expect(grant.headers?.["x-vercel-blob-access"]).toBe("private");
    expect(grant.headers?.["x-content-type"]).toBe("image/jpeg");
    expect(grant.headers?.["x-api-version"]).toBe("12");
    expect(grant.headers?.["x-api-blob-request-attempt"]).toBe("0");
  });

  it("embeds store id + now + random in the request id", () => {
    const grant = buildBlobGrant(
      { clientToken: CLIENT_TOKEN, pathname: "p", access: "private", contentType: "application/pdf" },
      { now: 7_000, rand: () => 0.25 },
    );
    expect(grant.headers?.["x-api-blob-request-id"]).toBe(`store:7000:${Math.floor(0.25 * 1e9).toString(16)}`);
  });

  it("url-encodes the pathname in the upload URL", () => {
    const grant = buildBlobGrant(
      { clientToken: CLIENT_TOKEN, pathname: "bol/d1/has space.jpg", access: "private", contentType: "image/jpeg" },
      { now: 0, rand: () => 0 },
    );
    expect(grant.uploadUrl).toBe("https://vercel.com/api/blob/?pathname=bol%2Fd1%2Fhas%20space.jpg");
  });
});
