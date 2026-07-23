"use server";

/**
 * Operator revocation of a (possibly lost) field device (plan 010, Phase 2).
 * Marks the device inactive + revoked and revokes its Better Auth session.
 * Gated by a signed-in web session (the web is operator-only behind SSO; per
 * the plan no role platform is added). Returns `{ ok, deviceId }` or an error.
 */

import { headers } from "next/headers";

import { getAuth } from "@/lib/auth";
import { getDevice, revokeDevice, deleteSessionById } from "@/lib/devices";

export interface RevokeResult {
  ok: boolean;
  deviceId?: string;
  error?: string;
}

export async function revokeDeviceAction(deviceId: string): Promise<RevokeResult> {
  const auth = getAuth();
  if (auth === null) {
    return { ok: false, error: "Auth is not configured" };
  }
  // The caller must be a signed-in web user (cookie session).
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return { ok: false, error: "Sign in to revoke a device" };
  }
  const device = await getDevice(deviceId);
  if (!device) {
    return { ok: false, error: "Device not found" };
  }
  const revokedSessionId = await revokeDevice(deviceId);
  if (revokedSessionId) {
    try {
      await deleteSessionById(revokedSessionId);
    } catch {
      // Best-effort; the device is already revoked.
    }
  }
  return { ok: true, deviceId };
}
