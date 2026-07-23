/**
 * Vercel Blob presigned-URL helpers for BOL artifacts (plan 010, Phase 3
 * operator cleanup — presigned-URL migration).
 *
 * The `rfid-bol` store is **private**. Uploads use presigned `PUT` URLs
 * (`issueSignedToken` + `presignUrl`, `@vercel/blob` ≥ 2.4.0; this repo runs
 * 2.6.1): the server mints a short-lived URL scoped to one pathname + `put`
 * operation + size/content-type caps, and the field app plain `fetch` PUTs the
 * bytes directly to Blob storage — no SDK on the device, no Vercel serverless
 * body cap (bytes never flow through the server). The store is private, so the
 * server also returns the canonical private object URL (`storageUrl`) for the
 * queue to record on a 200; the public `/tag/{epc}` page mints a short-lived
 * presigned `GET` URL on render to link the BOL without exposing the read-write
 * token.
 */

import {
  issueSignedToken,
  parseStoreIdFromDelegationToken,
  presignUrl,
  type IssuedSignedToken,
} from "@vercel/blob";

import { env } from "@/lib/env";

/** Max BOL page artifact size — enforced on the presigned PUT (CDN-side). */
export const MAX_BOL_BYTES = 25 * 1024 * 1024;

/** Content types the grant accepts, mapped to the pathname extension. */
const CONTENT_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};
export const ALLOWED_BOL_CONTENT_TYPES = Object.keys(CONTENT_EXT);

/** Grant lifetime (ms). Short; the queue re-requests on retry. */
const GRANT_TTL_MS = 5 * 60 * 1000;
/** Presigned GET lifetime for the tag page link (ms). */
const GET_TTL_MS = 5 * 60 * 1000;

/** The private-store host suffix for object URLs. */
const PRIVATE_HOST_SUFFIX = ".private.blob.vercel-storage.com";

/** A hex SHA-256 content hash (64 chars) produced by the field queue. */
export const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
/** A BOL doc id is a UUIDv4 (text PK, plan 010 Phase 2). */
export const DOC_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Content-addressed Blob pathname for one artifact: `bol/{docId}/{hash}.{ext}`. */
export function bolPathname(docId: string, contentHash: string, contentType: string): string {
  const ext = CONTENT_EXT[contentType];
  if (!ext) throw new Error(`unsupported BOL content type: ${contentType}`);
  return `bol/${docId}/${contentHash}.${ext}`;
}

/** The canonical private object URL for a pathname + store id. */
function privateObjectUrl(storeId: string, pathname: string): string {
  return `https://${storeId}${PRIVATE_HOST_SUFFIX}/${pathname}`;
}

/** Extract the pathname from a private object URL (for presigned GET on the tag page). */
export function pathnameFromStorageUrl(storageUrl: string): string {
  const u = new URL(storageUrl);
  // `pathname` is URL-encoded `/bol/{docId}/{hash}.{ext}`; decode to the raw pathname.
  return decodeURIComponent(u.pathname).replace(/^\/+/, "");
}

export interface BolPutGrant {
  presignedUrl: string;
  storageUrl: string;
  contentType: string;
}

/**
 * Mint a presigned PUT URL + canonical private object URL for one artifact.
 * Caller must have already authenticated the device session + checked the
 * allowlist + active device. Throws if Blob is not configured or the mint fails.
 */
export async function issueBolPutGrant(input: {
  docId: string;
  contentHash: string;
  contentType: string;
  sizeBytes: number;
}): Promise<BolPutGrant> {
  const blobToken = env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) throw new Error("BOL upload is not configured");

  const pathname = bolPathname(input.docId, input.contentHash, input.contentType);
  const validUntil = Date.now() + GRANT_TTL_MS;

  const token = await issueSignedToken({
    pathname,
    operations: ["put"],
    allowedContentTypes: ALLOWED_BOL_CONTENT_TYPES,
    maximumSizeInBytes: MAX_BOL_BYTES,
    validUntil,
    token: blobToken,
  });

  const storeId = parseStoreIdFromDelegationToken(token.delegationToken);
  const storageUrl = privateObjectUrl(storeId, pathname);

  const { presignedUrl } = await presignUrl(token, {
    operation: "put",
    pathname,
    access: "private",
    allowedContentTypes: ALLOWED_BOL_CONTENT_TYPES,
    maximumSizeInBytes: MAX_BOL_BYTES,
    addRandomSuffix: false,
    allowOverwrite: true,
    validUntil,
  });

  return { presignedUrl, storageUrl, contentType: input.contentType };
}

// -- Presigned GET for the public tag page -------------------------------------

/**
 * Module-level cache of `get`-delegation tokens keyed by pathname, reused until
 * near expiry so the public tag page doesn't call the Blob control API on every
 * render. `issueSignedToken` is the only network call here; `presignUrl` is
 * local HMAC. (Per the Vercel docs: "cache the result and reuse it across
 * requests until it's near expiry.")
 */
const getTokenCache = new Map<string, { token: IssuedSignedToken; expiresAt: number }>();
const GET_TOKEN_REFRESH_BEFORE_MS = 60_000;

async function getGetToken(pathname: string): Promise<IssuedSignedToken> {
  const cached = getTokenCache.get(pathname);
  const now = Date.now();
  if (cached && cached.expiresAt - now > GET_TOKEN_REFRESH_BEFORE_MS) {
    return cached.token;
  }
  const blobToken = env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) throw new Error("BOL upload is not configured");
  const token = await issueSignedToken({
    pathname,
    operations: ["get"],
    validUntil: now + GRANT_TTL_MS,
    token: blobToken,
  });
  getTokenCache.set(pathname, { token, expiresAt: token.validUntil });
  return token;
}

/**
 * Mint a short-lived presigned GET URL for a stored BOL (private object URL).
 * Used by the public `/tag/{epc}` page to link a BOL without exposing the
 * read-write token. Returns `null` when Blob is not configured (the tag page
 * then renders no link).
 */
export async function issueBolGetUrl(storageUrl: string): Promise<string | null> {
  if (!env.BLOB_READ_WRITE_TOKEN) return null;
  const pathname = pathnameFromStorageUrl(storageUrl);
  const token = await getGetToken(pathname);
  const { presignedUrl } = await presignUrl(token, {
    operation: "get",
    pathname,
    access: "private",
    validUntil: Date.now() + GET_TTL_MS,
  });
  return presignedUrl;
}
