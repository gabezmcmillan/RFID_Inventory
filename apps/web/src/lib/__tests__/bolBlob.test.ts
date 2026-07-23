import { beforeEach, describe, expect, test, vi } from "vitest";

const { envState, issueSignedToken, presignUrl } = vi.hoisted(() => {
  const envState: { BLOB_READ_WRITE_TOKEN?: string } = { BLOB_READ_WRITE_TOKEN: "rw-tok" };
  return {
    envState,
    issueSignedToken: vi.fn(),
    presignUrl: vi.fn(),
  };
});

vi.mock("@/lib/env", () => ({
  env: new Proxy(envState, {
    get: (t, p: string) => (p in t ? (t as Record<string, unknown>)[p] : undefined),
  }),
}));

vi.mock("@vercel/blob", () => ({
  issueSignedToken,
  presignUrl,
  parseStoreIdFromDelegationToken: (delegationToken: string) =>
    delegationToken.replace(/^store_/, "").replace(/-deleg$/, ""),
}));

const DOC_ID = "11111111-2222-3333-4444-555555555555";
const HASH = "a".repeat(64);
const PATHNAME = `bol/${DOC_ID}/${HASH}.jpg`;
const STORE_ID = "kuuqej6n3yfy58pt";
const STORAGE_URL = `https://${STORE_ID}.private.blob.vercel-storage.com/${PATHNAME}`;

function tokenResp(storeId = STORE_ID, validUntil = Date.now() + 60 * 60 * 1000) {
  return {
    delegationToken: `store_${storeId}-deleg`,
    clientSigningToken: "sign-secret",
    validUntil,
  };
}

/** Re-import a fresh bolBlob module (fresh module-level get-token cache) per test. */
async function freshBolBlob() {
  vi.resetModules();
  return (await import("@/lib/bolBlob")) as typeof import("@/lib/bolBlob");
}

describe("bolBlob", () => {
  beforeEach(() => {
    envState.BLOB_READ_WRITE_TOKEN = "rw-tok";
    issueSignedToken.mockReset();
    presignUrl.mockReset();
  });

  test("pathnameFromStorageUrl decodes the content-addressed pathname", async () => {
    const { pathnameFromStorageUrl } = await freshBolBlob();
    expect(pathnameFromStorageUrl(STORAGE_URL)).toBe(PATHNAME);
  });

  test("issueBolPutGrant mints a private presigned PUT + canonical private object URL", async () => {
    issueSignedToken.mockResolvedValue(tokenResp());
    presignUrl.mockResolvedValue({ presignedUrl: "https://put-presigned" });

    const { issueBolPutGrant } = await freshBolBlob();
    const grant = await issueBolPutGrant({
      docId: DOC_ID,
      contentHash: HASH,
      contentType: "image/jpeg",
      sizeBytes: 123,
    });

    expect(issueSignedToken).toHaveBeenCalledTimes(1);
    const [tokOpts] = issueSignedToken.mock.calls[0]!;
    expect(tokOpts).toMatchObject({
      pathname: PATHNAME,
      operations: ["put"],
      token: "rw-tok",
    });
    expect(tokOpts.allowedContentTypes).toContain("image/jpeg");
    expect(tokOpts.maximumSizeInBytes).toBeGreaterThan(0);

    expect(presignUrl).toHaveBeenCalledTimes(1);
    const [, urlOpts] = presignUrl.mock.calls[0]!;
    expect(urlOpts).toMatchObject({
      operation: "put",
      pathname: PATHNAME,
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    expect(grant.presignedUrl).toBe("https://put-presigned");
    expect(grant.storageUrl).toBe(STORAGE_URL);
    expect(grant.contentType).toBe("image/jpeg");
  });

  test("issueBolPutGrant throws when Blob is not configured", async () => {
    envState.BLOB_READ_WRITE_TOKEN = undefined;
    const { issueBolPutGrant } = await freshBolBlob();
    await expect(
      issueBolPutGrant({
        docId: DOC_ID,
        contentHash: HASH,
        contentType: "image/jpeg",
        sizeBytes: 1,
      }),
    ).rejects.toThrow(/not configured/);
  });

  test("issueBolGetUrl mints a private presigned GET for the tag page", async () => {
    issueSignedToken.mockResolvedValue(tokenResp());
    presignUrl.mockResolvedValue({ presignedUrl: "https://get-presigned" });

    const { issueBolGetUrl } = await freshBolBlob();
    const url = await issueBolGetUrl(STORAGE_URL);
    expect(url).toBe("https://get-presigned");

    expect(issueSignedToken).toHaveBeenCalledTimes(1);
    const [tokOpts] = issueSignedToken.mock.calls[0]!;
    expect(tokOpts).toMatchObject({ pathname: PATHNAME, operations: ["get"] });
    const [, urlOpts] = presignUrl.mock.calls[0]!;
    expect(urlOpts).toMatchObject({ operation: "get", pathname: PATHNAME, access: "private" });
  });

  test("issueBolGetUrl returns null when Blob is not configured (no link)", async () => {
    envState.BLOB_READ_WRITE_TOKEN = undefined;
    const { issueBolGetUrl } = await freshBolBlob();
    const url = await issueBolGetUrl(STORAGE_URL);
    expect(url).toBeNull();
    expect(issueSignedToken).not.toHaveBeenCalled();
  });

  test("issueBolGetUrl reuses the cached get-token for the same pathname", async () => {
    issueSignedToken.mockResolvedValue(tokenResp());
    presignUrl.mockResolvedValue({ presignedUrl: "https://get-presigned" });

    const { issueBolGetUrl } = await freshBolBlob();
    await issueBolGetUrl(STORAGE_URL);
    await issueBolGetUrl(STORAGE_URL);

    expect(issueSignedToken).toHaveBeenCalledTimes(1);
    expect(presignUrl).toHaveBeenCalledTimes(2);
  });
});
