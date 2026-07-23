/**
 * {@link GrantProvider} that mints a Vercel Blob client-upload grant by calling
 * the web app's `POST /api/bol/upload-grant` with the device's stored bearer
 * (plan 010, Phase 3). The server mints a short-lived client token bound to the
 * artifact's content-addressed pathname; this provider reconstructs the raw PUT
 * request (see {@link buildBlobGrant}) for the pure upload queue.
 *
 * Errors are thrown with a numeric `status` when the server responds (so the
 * queue records `{ kind: "http", status }`) or without one for a network/auth
 * failure (`{ kind: "network" }`). Messages never contain the bearer, client
 * token, or URL — and the queue discards messages anyway (redacted).
 */

import { buildBlobGrant, type GrantResponse } from "./buildBlobGrant";
import type { BlobGrant, GrantProvider, GrantRequest } from "./bolQueue";

export interface ServerBolGrantProviderDeps {
  fetchImpl: typeof fetch;
  /** The web app base URL (e.g. from `getServerUrl`). */
  getServerUrl: () => Promise<string>;
  /** The stored device bearer, or null when unlinked. */
  getBearer: () => Promise<string | null>;
  /** Injected clock/random so the request id is deterministic in tests. */
  now: () => number;
  rand: () => number;
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
    return buildBlobGrant(
      { ...body, contentType: req.contentType },
      { now: this._deps.now(), rand: this._deps.rand },
    );
  }
}
