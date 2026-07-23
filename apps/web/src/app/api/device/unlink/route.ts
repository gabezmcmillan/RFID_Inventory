/**
 * `POST /api/device/unlink` — unlink this field device (plan 010, Phase 2).
 * Marks the caller's active device inactive, clears its session ref, and
 * revokes the Better Auth session the bearer came from (so the bearer is
 * immediately dead). The EPC byte stays retired (never reused). On success
 * the phone clears its local Secure Store; the now-revoked bearer can no
 * longer call any device endpoint (subsequent calls get 401).
 */

import { getAuth } from "@/lib/auth";
import { getActiveDeviceForUser, unlinkDevice, deleteSessionById } from "@/lib/devices";
import { json, resolveDeviceSession, unauthorized } from "@/lib/deviceAuth";

export async function POST(request: Request): Promise<Response> {
  const auth = getAuth();
  const session = await resolveDeviceSession(auth, request);
  if (!session) return unauthorized();

  const device = await getActiveDeviceForUser(session.userId);
  if (!device) {
    return json({ error: "No active field device to unlink" }, 404);
  }

  const revokedSessionId = await unlinkDevice(device.id);

  // Revoke the Better Auth session the bearer came from (if it was this
  // device's session) by deleting its row — the bearer then dies immediately.
  if (revokedSessionId) {
    try {
      await deleteSessionById(revokedSessionId);
    } catch {
      // Best-effort: the device row is already inactive; a stale session will
      // expire on its own. Don't fail the unlink over it.
    }
  }

  return json({ ok: true, deviceId: device.id }, 200);
}
