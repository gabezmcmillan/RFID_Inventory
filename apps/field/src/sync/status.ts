/**
 * Sync status states (plan 010, Phase 3). The coordinator emits exactly these
 * states; the UI maps each to a label. `reauth` covers a revoked/expired
 * credential or an incompatible server schema requiring an app upgrade — both
 * mean the device must re-link or upgrade, not retry forever.
 */
export type SyncStatus =
  | "idle" // initial / no pending work
  | "syncing" // a push+pull cycle is in flight
  | "synced" // last cycle succeeded; last time recorded
  | "pending" // offline with local changes waiting to push
  | "retrying" // a transient failure; will retry after backoff
  | "reauth" // credential revoked/expired OR schema upgrade required — re-link/upgrade
  | "blocked"; // writes blocked: server schema is incompatible with this build

/** Human-facing label for each status. */
export function statusLabel(status: SyncStatus): string {
  switch (status) {
    case "idle":
      return "Up to date";
    case "syncing":
      return "Syncing…";
    case "synced":
      return "Synced";
    case "pending":
      return "Offline — changes waiting";
    case "retrying":
      return "Retrying sync…";
    case "reauth":
      return "Re-link or upgrade required";
    case "blocked":
      return "Update required to sync";
  }
}
