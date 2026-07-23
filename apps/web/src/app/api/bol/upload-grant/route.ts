/**
 * `POST /api/bol/upload-grant` — mint a short-lived Vercel Blob client-upload
 * grant for one BOL page artifact (plan 010, Phase 3). The field app's BOL
 * upload queue hits this with the stored bearer to get a single-use client
 * token bound to a content-addressed pathname, then PUTs the artifact bytes
 * directly to Vercel Blob (bytes never touch this server).
 *
 * Checks: a valid bearer session, the user's email is on the allowlist, and the
 * device is active. Requires `BLOB_READ_WRITE_TOKEN` server-side. The grant is
 * bound to `bol/{docId}/{contentHash}.{ext}` (no random suffix, no overwrite),
 * capped at {@link MAX_BOL_BYTES} and restricted to BOL content types, and
 * expires in {@link GRANT_TTL_SEC}.
 */

import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { getAuth } from "@/lib/auth";
import { isAllowed } from "@/lib/allowlist";
import { env } from "@/lib/env";
import { getActiveDeviceForUser } from "@/lib/devices";
import { forbidden, json, resolveDeviceSession, unauthorized } from "@/lib/deviceAuth";

/** Grant lifetime (seconds). Short; the queue re-requests on retry. */
const GRANT_TTL_SEC = 5 * 60;

/** Max BOL page artifact size (25 MB — a scanned JPEG page or a small PDF). */
const MAX_BOL_BYTES = 25 * 1024 * 1024;

/** Content types the queue may upload, mapped to the pathname extension. */
const CONTENT_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};
const ALLOWED_CONTENT_TYPES = Object.keys(CONTENT_EXT);

/** A hex SHA-256 content hash (64 chars) produced by the field queue. */
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
/** A BOL doc id is a UUIDv4 (text PK, plan 010 Phase 2). */
const DOC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GrantBody {
  docId: string;
  contentHash: string;
  contentType: string;
  sizeBytes: number;
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

function parseBody(raw: unknown): GrantBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  const { docId, contentHash, contentType, sizeBytes } = b;
  if (typeof docId !== "string" || !DOC_ID_RE.test(docId)) return null;
  if (typeof contentHash !== "string" || !CONTENT_HASH_RE.test(contentHash)) return null;
  if (typeof contentType !== "string" || !(contentType in CONTENT_EXT)) return null;
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
  if (sizeBytes > MAX_BOL_BYTES) return null;
  return { docId, contentHash, contentType, sizeBytes };
}

export async function POST(request: Request): Promise<Response> {
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

  let body: GrantBody | null;
  try {
    body = parseBody(await request.json());
  } catch {
    return badRequest("Invalid request body");
  }
  if (!body) return badRequest("Invalid BOL upload request");

  const ext = CONTENT_EXT[body.contentType]!;
  const pathname = `bol/${body.docId}/${body.contentHash}.${ext}`;
  const validUntil = Date.now() + GRANT_TTL_SEC * 1000;

  let clientToken: string;
  try {
    clientToken = await generateClientTokenFromReadWriteToken({
      token: blobToken,
      pathname,
      validUntil,
      addRandomSuffix: false,
      allowOverwrite: false,
      maximumSizeInBytes: MAX_BOL_BYTES,
      allowedContentTypes: ALLOWED_CONTENT_TYPES,
    });
  } catch {
    return json({ error: "Failed to mint a BOL upload grant" }, 502);
  }

  return json({ clientToken, pathname, access: "private" as const, expiresAt: GRANT_TTL_SEC }, 200);
}
