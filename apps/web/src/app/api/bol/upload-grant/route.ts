/**
 * `POST /api/bol/upload-grant` — mints a Vercel Blob presigned PUT URL for one
 * BOL artifact (plan 010, Phase 3 operator cleanup — presigned-URL migration).
 *
 * The field app's BOL upload queue POSTs the artifact's `(docId, contentHash,
 * contentType, sizeBytes)` with the device bearer; this route authenticates the
 * device session (same checks as the former proxy: valid bearer, allowlist,
 * active device, Blob configured), then mints a short-lived presigned `PUT` URL
 * scoped to the exact content-addressed pathname + `put` operation + size +
 * content-type caps, and returns it alongside the canonical private object URL
 * (`storageUrl`). The device plain `fetch` PUTs the bytes directly to Blob
 * storage — no `@vercel/blob` SDK on the device, no reconstructed SDK internals,
 * and no Vercel serverless request-body cap (bytes never flow through the
 * server). The `rfid-bol` store is private, so the server returns the private
 * object URL for the queue to record on a 200; the public `/tag/{epc}` page mints
 * a presigned GET to link it.
 *
 * The size cap is enforced on the presigned URL itself (`maximumSizeInBytes` is
 * bound into the delegation token and enforced by the CDN), so an oversized
 * device upload is rejected at the CDN without streaming to a server function.
 */

import { getAuth } from "@/lib/auth";
import { isAllowed } from "@/lib/allowlist";
import { env } from "@/lib/env";
import { getActiveDeviceForUser } from "@/lib/devices";
import { forbidden, json, resolveDeviceSession, unauthorized } from "@/lib/deviceAuth";
import {
  ALLOWED_BOL_CONTENT_TYPES,
  CONTENT_HASH_RE,
  DOC_ID_RE,
  MAX_BOL_BYTES,
  issueBolPutGrant,
} from "@/lib/bolBlob";

interface GrantMeta {
  docId: string;
  contentHash: string;
  contentType: string;
  sizeBytes: number;
}

function parseMeta(body: unknown): GrantMeta | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const { docId, contentHash, contentType, sizeBytes } = b;
  if (typeof docId !== "string" || !DOC_ID_RE.test(docId)) return null;
  if (typeof contentHash !== "string" || !CONTENT_HASH_RE.test(contentHash)) return null;
  if (typeof contentType !== "string" || !ALLOWED_BOL_CONTENT_TYPES.includes(contentType)) {
    return null;
  }
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return null;
  }
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

  if (!env.BLOB_READ_WRITE_TOKEN) {
    return json({ error: "BOL upload is not configured" }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }
  const meta = parseMeta(body);
  if (!meta) return json({ error: "Invalid BOL upload grant request" }, 400);

  try {
    const grant = await issueBolPutGrant(meta);
    return json(grant, 200);
  } catch {
    return json({ error: "Failed to mint the BOL upload grant" }, 502);
  }
}
