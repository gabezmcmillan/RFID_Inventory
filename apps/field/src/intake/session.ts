/**
 * The app-wide {@link IntakeSession} singleton. The check-in screen and the
 * print path share one armed-shipment state machine; keeping it here (not in
 * component state) survives navigation away and back during a check-in
 * session and matches the Python app's single `ShipmentIntake` instance.
 *
 * The session is constructed with the on-device EPC serial allocator (the
 * local-only `device.db`). The allocator opens lazily on the first print
 * (checkInPrinted), so this module stays sync-free to import.
 */

import { type EpcSerialAllocator, IntakeSession } from "@rfid/domain";

import { getDeviceAllocator } from "../db/deviceDb";

let cached: EpcSerialAllocator | null = null;
async function allocator(): Promise<EpcSerialAllocator> {
  if (!cached) cached = await getDeviceAllocator();
  return cached;
}

/** Shared armed-shipment state machine for the field app. */
export const intakeSession = new IntakeSession({
  deviceId: async () => (await allocator()).deviceId(),
  reserveSerials: async (n: number) => (await allocator()).reserveSerials(n),
});
