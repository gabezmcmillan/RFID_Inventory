/**
 * Build a raw PUT {@link BlobGrant} for a Vercel Blob client-upload from the
 * fields the server grant endpoint returns (plan 010, Phase 3).
 *
 * Why a raw PUT and not `@vercel/blob/client`'s `put()`: the field app is
 * React Native, and `@vercel/blob/client` imports node-only `crypto` + `undici`
 * (no RN polyfill), so it cannot run on-device. The Vercel Blob client upload
 * is a single PUT of the raw bytes to the Blob control API with the client
 * token in an `authorization` header and the store id in
 * `x-vercel-blob-store-id` (the SDK does exactly this in `requestApi`). We
 * reconstruct that request shape here so the pure upload queue can upload via
 * plain `fetch` (RN-compatible) without any `@vercel/blob` dependency on the
 * device.
 *
 * CAVEAT (on-device validation required): the API URL, version, and header
 * names are @verel/blob control-plane internals reconstructed from the SDK
 * (v2.6.1). If the SDK changes them, this must be updated. The request shape
 * is unit-tested deterministically; the live upload must be validated on a
 * device against the `rfid-bol` store.
 */

import type { BlobGrant } from "./bolQueue";

/** Fields the server grant endpoint returns for one artifact. */
export interface GrantResponse {
  /** `vercel_blob_client_<storeId>_<base64>` from `generateClientTokenFromReadWriteToken`. */
  clientToken: string;
  /** Content-addressed pathname, e.g. `bol/<docId>/<hash>.jpg`. */
  pathname: string;
  /** Store access level ("private" for the rfid-bol store). */
  access: "public" | "private";
}

/** The artifact's content type (the field app knows it from the captured file). */
export interface BuildGrantInput extends GrantResponse {
  contentType: string;
}

/** Injected clock/random so the request id is deterministic in tests. */
export interface BuildGrantDeps {
  now: number;
  rand: () => number;
}

/** Vercel Blob control API base (SDK default, v2.6.1). */
const BLOB_API_URL = "https://vercel.com/api/blob";
/** Vercel Blob API version (SDK `BLOB_API_VERSION`, v2.6.1). */
const BLOB_API_VERSION = "12";

/** Extract the bare store id from a `vercel_blob_client_<storeId>_<base64>` token. */
export function parseStoreId(clientToken: string): string {
  // `vercel_blob_client_<storeId>_<base64>` — storeId is the 4th `_`-segment.
  // Bare store ids are alphanumeric (no underscore), so this split is safe.
  const seg = clientToken.split("_")[3];
  if (!seg) throw new Error("invalid client token: missing store id");
  return seg;
}

/** Build the raw PUT request grant for the pure upload queue. */
export function buildBlobGrant(input: BuildGrantInput, deps: BuildGrantDeps): BlobGrant {
  const storeId = parseStoreId(input.clientToken);
  const requestId = `${storeId}:${deps.now}:${Math.floor(deps.rand() * 1e9).toString(16)}`;
  const uploadUrl = `${BLOB_API_URL}/?pathname=${encodeURIComponent(input.pathname)}`;
  return {
    uploadUrl,
    method: "PUT",
    headers: {
      authorization: `Bearer ${input.clientToken}`,
      "x-vercel-blob-store-id": storeId,
      "x-vercel-blob-access": input.access,
      "x-content-type": input.contentType,
      "x-api-version": BLOB_API_VERSION,
      "x-api-blob-request-id": requestId,
      "x-api-blob-request-attempt": "0",
    },
  };
}
