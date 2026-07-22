/**
 * "Sync now" — the integration hook called after a request is mutated
 * (declined, fulfilled, or staging canceled), mirroring the Python app's
 * immediate `state.sync.sync_now()` push "to tell the requester ASAP"
 * (app.py:521-523, 539-541).
 *
 * Plan 010 wires the real Turso `push()` here. Until then this is a no-op so
 * the call sites exist in one place rather than as scattered TODOs.
 */

export async function syncNow(): Promise<void> {
  // No-op placeholder; plan 010 replaces this with a real cloud push.
}
