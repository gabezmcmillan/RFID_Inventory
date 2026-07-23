/**
 * Pure field-app version-check logic (plan 010, Phase 5). No React, no network,
 * no native modules — fully deterministic and unit-testable. The provider
 * (`VersionCheckProvider.tsx`) wires this to a `fetch` of `GET /api/field/version`
 * and the device's installed build number (`Application.nativeBuildVersion`),
 * both injected so the logic here stays pure.
 */

export type VersionCheckStatus =
  | "idle"
  | "checking"
  | "current"
  | "stale"
  | "error";

export interface VersionCheckState {
  status: VersionCheckStatus;
  /** Latest build number known to the server, or null when unknown. */
  latestBuildNumber: number | null;
  /** Install-page URL from the server, or null. */
  installUrl: string | null;
  /** A user-facing error message when `status === "error"`. */
  error: string | null;
}

export const initialVersionCheckState: VersionCheckState = {
  status: "idle",
  latestBuildNumber: null,
  installUrl: null,
  error: null,
};

/** Parse a build number (string | number) into a positive integer, or null. */
export function parseBuildNumber(
  raw: string | number | null | undefined,
): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Decide whether the installed build is stale relative to the latest known
 * build. Returns `false` (no banner) when either side is unknown — a false
 * "update available" banner is worse than no banner, and a fresh install or an
 * undeployed build shouldn't nag. Stale only when both are known and the
 * latest is strictly greater than the installed build.
 */
export function isStaleBuild(
  current: number | null,
  latest: number | null,
): boolean {
  if (current === null || latest === null) return false;
  return latest > current;
}

export type VersionCheckEvent =
  | { type: "check-start" }
  | {
      type: "check-success";
      installedBuildNumber: number | null;
      latestBuildNumber: number;
      installUrl: string;
    }
  | { type: "check-error"; error: string }
  | { type: "dismiss" }
  | { type: "reset" };

export function versionCheckReducer(
  state: VersionCheckState,
  event: VersionCheckEvent,
): VersionCheckState {
  switch (event.type) {
    case "check-start":
      return { ...state, status: "checking", error: null };
    case "check-success": {
      const stale = isStaleBuild(event.installedBuildNumber, event.latestBuildNumber);
      return {
        status: stale ? "stale" : "current",
        latestBuildNumber: event.latestBuildNumber,
        installUrl: event.installUrl,
        error: null,
      };
    }
    case "check-error":
      return { ...state, status: "error", error: event.error };
    case "dismiss":
      return state.status === "stale" ? { ...state, status: "current" } : state;
    case "reset":
      return initialVersionCheckState;
    default:
      return state;
  }
}
