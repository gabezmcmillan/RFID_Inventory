/**
 * Module-level access to the live {@link SyncCoordinator} (plan 010, Phase 3).
 *
 * The {@link SyncProvider} sets the singleton once it has built the coordinator
 * from the opened database + credential store. The legacy `syncNow()` hook and
 * the unlink/relink flow call {@link triggerMutation}/{@link resetSync} here so
 * they don't need React context. `null` before the provider mounts.
 */

import type { SyncCoordinator } from "./coordinator";
import type { SyncCredentialStore } from "./credentialStore";

let coordinator: SyncCoordinator | null = null;
let credStore: SyncCredentialStore | null = null;

/** Called by {@link SyncProvider} when the coordinator is ready. */
export function setCoordinator(c: SyncCoordinator | null): void {
  coordinator = c;
}

/** Called by {@link SyncProvider} so the unlink flow can drop the cached
 *  sync token without React context. */
export function setCredentialStore(c: SyncCredentialStore | null): void {
  credStore = c;
}

/** The live coordinator, or null before the provider mounts. */
export function getCoordinator(): SyncCoordinator | null {
  return coordinator;
}

/** Debounced "a local mutation happened — sync soon" trigger. */
export function triggerMutation(): void {
  coordinator?.trigger("mutation");
}

/** Manual "sync now" trigger (immediate cycle). */
export function triggerManualSync(): void {
  coordinator?.trigger("manual");
}

/** Drop the cached sync token (called on unlink so the next cycle goes reauth). */
export function clearSyncCredential(): void {
  credStore?.clear();
}

/** Escape hatch after the operator re-links or upgrades (clears reauth/blocked). */
export function resetSync(): void {
  coordinator?.reset();
}
