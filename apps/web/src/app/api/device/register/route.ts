/**
 * `POST /api/device/register` — link a freshly-authenticated field device
 * (plan 010, Phase 2). The phone first exchanges the QR one-time token at
 * Better Auth's `/api/auth/one-time-token/verify` (single-use) and receives a
 * bearer session; it then calls here with that bearer to register the device.
 *
 * Checks: a valid bearer session, the user's email is on the field-operator
 * allowlist, and the user has no other active device (unlink first). On
 * success assigns a permanent, never-reused 2-hex EPC byte and returns the
 * device id + byte (the phone stores the byte in its local-only device DB).
 */

import { randomUUID } from "node:crypto";

import { getAuth } from "@/lib/auth";
import { isAllowed } from "@/lib/allowlist";
import { env } from "@/lib/env";
import {
  allocateNextEpcByte,
  getActiveDeviceForUser,
  insertDevice,
} from "@/lib/devices";
import { forbidden, json, resolveDeviceSession, unauthorized } from "@/lib/deviceAuth";

export async function POST(request: Request): Promise<Response> {
  const auth = getAuth();
  const session = await resolveDeviceSession(auth, request);
  if (!session) return unauthorized();

  if (!isAllowed(session.email, env.FIELD_OPERATOR_ALLOWLIST)) {
    return forbidden("Your account is not permitted to link a field device");
  }

  // One active device per user; unlink the old one before linking a new one.
  const existing = await getActiveDeviceForUser(session.userId);
  if (existing) {
    return json({ error: "A device is already linked to this account; unlink it first" }, 409);
  }

  const epcByte = await allocateNextEpcByte();
  if (!epcByte) {
    return json({ error: "No device bytes remaining (all 256 are assigned)" }, 503);
  }

  let label: string | null = null;
  try {
    const body = (await request.json()) as { label?: unknown };
    if (typeof body.label === "string" && body.label.trim().length > 0) {
      label = body.label.trim().slice(0, 64);
    }
  } catch {
    // No body / invalid JSON is fine — label is optional.
  }

  const deviceId = randomUUID();
  await insertDevice({
    id: deviceId,
    user_id: session.userId,
    session_id: session.sessionId,
    epc_byte: epcByte,
    label,
    active: 1,
    created_at: new Date().toISOString(),
    revoked_at: null,
    unlinked_at: null,
  });

  return json({ deviceId, epcByte, label }, 200);
}
