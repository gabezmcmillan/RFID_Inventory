/**
 * `PUT /api/bol/upload` — server-side BOL upload proxy (plan 010, Phase 3
 * operator cleanup). The field app's BOL upload queue PUTs one artifact's bytes
 * here with the device bearer and content-addressed metadata headers; this
 * route uploads them to Vercel Blob with the official `@vercel/blob` server SDK
 * `put()` and returns the object URL, which the queue records as the doc's
 * `storage_url` so the public `/tag/{epc}` page can link it.
 *
 * Why a server proxy and not a Vercel Blob client-upload grant: the documented
 * client-upload flow needs `@vercel/blob/client`'s JS SDK, which can't run on
 * React Native (node `crypto`/`undici`). The client PUT wire format is an SDK
 * internal, not a public contract — reconstructing it (the former
 * `buildBlobGrant`) coupled us to SDK internals. The proxy uses only the
 * supported server SDK. The tradeoff is the Vercel serverless request-body cap
 * (~4.5 MB): the route enforces a 4 MB cap (Content-Length + actual body) and
 * the field app pre-flights the same limit. BOL scan pages are already
 * compressed JPEGs well under the cap; per-page uploads keep each request
 * small.
 *
 * Checks: a valid bearer session, the user's email is on the allowlist, the
 * device is active, and `BLOB_READ_WRITE_TOKEN` is set. The Blob pathname is
 * bound to `bol/{docId}/{contentHash}.{ext}` from the validated headers (the
 * client never supplies a pathname), `addRandomSuffix: false`, and
 * `allowOverwrite: true` (the path is content-addressed, so re-uploads are
 * idempotent and produce the same URL). `access: 'public'` so the public tag
 * page link works without a signed URL.
 */

import { put } from "@vercel/blob";
import { getAuth } from "@/lib/auth";
import { isAllowed } from "@/lib/allowlist";
import { env } from "@/lib/env";
import { getActiveDeviceForUser } from "@/lib/devices";
import { forbidden, json, resolveDeviceSession, unauthorized } from "@/lib/deviceAuth";

/** Max BOL page artifact size — safely under the Vercel serverless body cap. */
export const MAX_BOL_BYTES = 4 * 1024 * 1024;

/** Content types the proxy accepts, mapped to the pathname extension. */
const CONTENT_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};

/** A hex SHA-256 content hash (64 chars) produced by the field queue. */
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
/** A BOL doc id is a UUIDv4 (text PK, plan 010 Phase 2). */
const DOC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface UploadMeta {
  docId: string;
  contentHash: string;
  contentType: string;
}

function parseMeta(headers: Headers): UploadMeta | null {
  const docId = headers.get("x-bol-doc-id");
  const contentHash = headers.get("x-bol-content-hash");
  const contentType = headers.get("x-bol-content-type");
  if (typeof docId !== "string" || !DOC_ID_RE.test(docId)) return null;
  if (typeof contentHash !== "string" || !CONTENT_HASH_RE.test(contentHash)) return null;
  if (typeof contentType !== "string" || !(contentType in CONTENT_EXT)) return null;
  return { docId, contentHash, contentType };
}

export async function PUT(request: Request): Promise<Response> {
  const auth = getAuth();
  const session = await resolveDeviceSession(auth, request);
  if (!session) return unauthorized();

  if (!isAllowed(session.email, env.FIELD_OPERATOR_ALLOWLIST)) {
    return forbidden("Your account is not permitted to upload BOLs");
  }

  const device = await getActiveDeviceForUser(session.userId);
  if (!device) {
    return forbidden("No active field device; re-link this device");
  }

  const blobToken = env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    return json({ error: "BOL upload is not configured" }, 503);
  }

  const meta = parseMeta(request.headers);
  if (!meta) return json({ error: "Invalid BOL upload metadata" }, 400);

  // Reject oversized uploads before buffering the body. Content-Length is
  // client-reported, so the actual body length is re-checked after the read.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BOL_BYTES) {
    return json({ error: "BOL artifact exceeds the 4 MB upload limit" }, 413);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BOL_BYTES) {
    return json({ error: "BOL artifact exceeds the 4 MB upload limit" }, 413);
  }
  if (body.byteLength === 0) {
    return json({ error: "Empty BOL artifact" }, 400);
  }

  const ext = CONTENT_EXT[meta.contentType]!;
  const pathname = `bol/${meta.docId}/${meta.contentHash}.${ext}`;

  let result: { url: string };
  try {
    result = await put(pathname, body, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: meta.contentType,
      token: blobToken,
    });
  } catch {
    return json({ error: "Failed to upload the BOL artifact" }, 502);
  }

  return json({ url: result.url }, 200);
}
