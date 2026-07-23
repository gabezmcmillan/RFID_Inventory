"use server";

/**
 * Operator admin actions for the field-device registry (plan 010, Phase 2 +
 * operator scope addition). Gated by a signed-in web session (the web is
 * operator-only behind SSO; per the plan no role platform is added). Each
 * returns `{ ok, deviceId?, error? }`.
 *
 * Lifecycle states (kept distinct so the flow is unambiguous):
 *  - **deactivate** (soft): `active=0`, session KEPT. Blocks credential
 *    refresh (the field app's pushes stop within the token TTL) but lets
 *    reactivation flip the device back on without re-linking.
 *  - **reactivate**: `active=1`, clears `deactivated_at`. The field app resumes
 *    via its manual "retry" escape hatch after the operator reactivates.
 *  - **revoke** (lost device): `active=0` + revoked, session deleted, EPC byte
 *    retired forever. Requires re-linking a new device.
 */

import { headers } from "next/headers";

import { getAuth } from "@/lib/auth";
import {
  deactivateDevice,
  deleteSessionById,
  getDevice,
  reactivateDevice,
  renameDevice,
  revokeDevice,
} from "@/lib/devices";

export interface DeviceActionResult {
  ok: boolean;
  deviceId?: string;
  error?: string;
}

/** Resolve the signed-in web session or return an error result. */
async function requireSession(): Promise<
  { ok: true; userId: string } | { ok: false; error: string }
> {
  const auth = getAuth();
  if (auth === null) return { ok: false, error: "Auth is not configured" };
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { ok: false, error: "Sign in to manage devices" };
  return { ok: true, userId: session.user.id };
}

/** Rename a device's display label (clamped to 64 chars). */
export async function renameDeviceAction(
  deviceId: string,
  label: string,
): Promise<DeviceActionResult> {
  const session = await requireSession();
  if (!session.ok) return session;
  const trimmed = label.trim().slice(0, 64);
  if (trimmed.length === 0) return { ok: false, error: "Label cannot be empty" };
  const device = await getDevice(deviceId);
  if (!device) return { ok: false, error: "Device not found" };
  const updated = await renameDevice(deviceId, trimmed);
  if (!updated) return { ok: false, error: "Device not found" };
  return { ok: true, deviceId };
}

/** Soft-deactivate a device: block credential refresh, keep the session. */
export async function deactivateDeviceAction(deviceId: string): Promise<DeviceActionResult> {
  const session = await requireSession();
  if (!session.ok) return session;
  const device = await getDevice(deviceId);
  if (!device) return { ok: false, error: "Device not found" };
  const updated = await deactivateDevice(deviceId);
  if (!updated) return { ok: false, error: "Device is already inactive" };
  return { ok: true, deviceId };
}

/** Reactivate a soft-deactivated device: re-allow credential refresh. */
export async function reactivateDeviceAction(deviceId: string): Promise<DeviceActionResult> {
  const session = await requireSession();
  if (!session.ok) return session;
  const device = await getDevice(deviceId);
  if (!device) return { ok: false, error: "Device not found" };
  const updated = await reactivateDevice(deviceId);
  if (!updated) return { ok: false, error: "Device is already active" };
  return { ok: true, deviceId };
}

/**
 * Operator revocation of a (possibly lost) field device (plan 010, Phase 2).
 * Marks the device inactive + revoked and revokes its Better Auth session.
 */
export async function revokeDeviceAction(deviceId: string): Promise<DeviceActionResult> {
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
