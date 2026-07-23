/**
 * "Sync now" — the integration hook called after a request is mutated
 * (declined, fulfilled, or staging canceled), mirroring the Python app's
 * immediate `state.sync.sync_now()` push "to tell the requester ASAP"
 * (app.py:521-523, 539-541).
 *
 * Plan 010 Phase 3 wires this to the live {@link SyncCoordinator} as a
 * debounced mutation trigger (coalesces a burst of writes into one cycle). It
 * is a no-op before the coordinator is mounted.
 */

import { triggerMutation } from "./access";

export async function syncNow(): Promise<void> {
  triggerMutation();
}
