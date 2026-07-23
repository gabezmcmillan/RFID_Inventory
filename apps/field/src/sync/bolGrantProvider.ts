/**
 * {@link GrantProvider} that returns a grant pointing the upload queue at the
 * web app's server-side BOL upload proxy `PUT /api/bol/upload` (plan 010,
 * Phase 3 operator cleanup).
 *
 * Why a server proxy and not a Vercel Blob client-upload grant: the documented
 * client-upload flow requires `@vercel/blob/client`'s JS SDK (`upload`/`put`),
 * which imports node-only `crypto` + `undici` and cannot run on React Native. The
 * client-side PUT wire format (control-API URL, `x-vercel-blob-store-id`,
 * `x-api-version`, …) is an SDK internal, not a documented public contract, so
 * reconstructing it (the former `buildBlobGrant`) coupled us to SDK internals.
 * Instead the queue PUTs the artifact bytes to this server route, which uploads
 * to Vercel Blob with the official server SDK `put()`. The bytes flow through
 * the server, so the upload is bounded by the Vercel serverless request-body
 * cap (~4.5 MB) — the proxy enforces a 4 MB cap and the field app pre-flights
 * the same limit (see `enqueueBolArtifact`).
 *
 * The grant carries the artifact's content-addressed metadata in headers so the
 * proxy can bind the Blob pathname to `bol/{docId}/{contentHash}.{ext}` without
 * trusting a client-supplied pathname. `getUploadGrant` does no network call —
 * it just constructs the proxy URL + headers; the queue's PUT does the auth and
 * upload, and the proxy rejects early (401/403/503) before consuming the body.
 */
import type { BlobGrant, GrantProvider, GrantRequest } from "./bolQueue";

export interface ServerBolGrantProviderDeps {
  fetchImpl: typeof fetch;
  /** The web app base URL (e.g. from `getServerUrl`). */
  getServerUrl: () => Promise<string>;
  /** The stored device bearer, or null when unlinked. */
  getBearer: () => Promise<string | null>;
}

export class ServerBolGrantProvider implements GrantProvider {
  constructor(private readonly _deps: ServerBolGrantProviderDeps) {}

  /**
   * Return the proxy grant. The queue immediately PUTs the artifact bytes to
   * {@link grant.uploadUrl} with {@link grant.headers}; the proxy uploads them
   * to Vercel Blob and returns the object URL, which the queue records as the
   * entry's `storage_url`. Throws only when there is no linked bearer.
   */
  async getUploadGrant(req: GrantRequest): Promise<BlobGrant> {
    const bearer = await this._deps.getBearer();
    if (!bearer) throw new Error("no linked device bearer");

    const uploadUrl = `${await this._deps.getServerUrl()}/api/bol/upload`;
    return {
      uploadUrl,
      method: "PUT",
      headers: {
        authorization: `Bearer ${bearer}`,
        "x-bol-doc-id": req.docId,
        "x-bol-content-hash": req.contentHash,
        "x-bol-content-type": req.contentType,
      },
    };
  }
}
