/**
 * {@link GrantProvider} that mints a Vercel Blob presigned PUT URL by calling
 * the web app's `POST /api/bol/upload-grant` with the device's stored bearer
 * (plan 010, Phase 3 operator cleanup — presigned-URL migration).
 *
 * Why presigned URLs and not a server proxy: Vercel Blob ships GA presigned
 * upload URLs (`issueSignedToken` + `presignUrl`, `@vercel/blob` ≥ 2.4.0; this
 * repo runs 2.6.1). The server mints a short-lived URL scoped to one pathname +
 * `put` operation + size/content-type caps; the field app plain `fetch` PUTs
 * the artifact bytes directly to Blob storage — no `@vercel/blob` SDK on the
 * device (RN can't run it), no reconstructed SDK internals, and no Vercel
 * serverless request-body cap (bytes never flow through the server). The
 * `rfid-bol` store is private, so the server also returns the canonical
 * private object URL (`storageUrl`) for the queue to record on a 200.
 *
 * Errors are thrown with a numeric `status` when the server responded (so the
 * queue records `{ kind: "http", status }`) or without one for a network/auth
 * failure (`{ kind: "network" }`). Messages never contain the bearer,
 * presigned URL, or `storageUrl` — and the queue discards messages anyway
 * (redacted).
 */

import type { BlobGrant, GrantProvider, GrantRequest } from "./bolQueue";

/** Fields the server grant endpoint returns for one artifact. */
export interface GrantResponse {
  /** Time-limited presigned PUT URL the device fetch-PUTs the bytes to. */
  presignedUrl: string;
  /** Canonical private object URL the upload produces (recorded as storage_url). */
  storageUrl: string;
  /** The artifact's content type (echoed so the PUT sends the right header). */
  contentType: string;
}

export interface ServerBolGrantProviderDeps {
  fetchImpl: typeof fetch;
  /** The web app base URL (e.g. from `getServerUrl`). */
  getServerUrl: () => Promise<string>;
  /** The stored device bearer, or null when unlinked. */
  getBearer: () => Promise<string | null>;
}

function httpError(status: number): Error {
  const e = new Error(`bol grant rejected (${status})`);
  (e as Error & { status: number }).status = status;
  return e;
}

export class ServerBolGrantProvider implements GrantProvider {
  constructor(private readonly _deps: ServerBolGrantProviderDeps) {}

  async getUploadGrant(req: GrantRequest): Promise<BlobGrant> {
    const bearer = await this._deps.getBearer();
    if (!bearer) throw new Error("no linked device bearer");

    const url = `${await this._deps.getServerUrl()}/api/bol/upload-grant`;
    let res: Response;
    try {
      res = await this._deps.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          docId: req.docId,
          contentHash: req.contentHash,
          contentType: req.contentType,
          sizeBytes: req.sizeBytes,
        }),
      });
    } catch {
      throw new Error("bol grant network failure");
    }
    if (!res.ok) throw httpError(res.status);

    let body: GrantResponse;
    try {
      body = (await res.json()) as GrantResponse;
    } catch {
      throw new Error("bol grant bad response");
    }
    if (!body.presignedUrl || !body.storageUrl || !body.contentType) {
      throw new Error("bol grant missing fields");
    }
    return {
      uploadUrl: body.presignedUrl,
      method: "PUT",
      headers: { "content-type": body.contentType },
      storageUrl: body.storageUrl,
    };
  }
}
