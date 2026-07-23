/**
 * Field version-check I/O seams (plan 010, Phase 5). The pure compare logic
 * lives in `versionCheck.ts`; this module reads the installed build number
 * (from `expo-application`'s `Application.nativeBuildVersion` — the native
 * CFBundleVersion, which CI sets to the run number) and fetches the latest
 * build metadata from `GET /api/field/version`. Both are injected into the
 * provider so the reducer stays pure and unit-testable.
 */

import { fieldEnv } from "../config/env";
import { normalizeServerUrl } from "../config/url";

/** Latest-version response from `GET /api/field/version`. */
export interface LatestFieldVersion {
  buildNumber: number;
  installUrl: string;
}

/**
 * Read this device's installed build number from
 * `Application.nativeBuildVersion` (the native CFBundleVersion CI sets to the
 * run number). Returns `null` when unavailable (simulator, JS-only export, or
 * the native module isn't linked yet) — the provider treats null as "can't
 * tell", so no false update banner. `expo-application` is imported lazily so
 * unit tests and the JS-only `expo export` don't require the native binary.
 */
export async function getInstalledBuildNumber(): Promise<number | null> {
  try {
    const mod = await import("expo-application");
    const raw = mod.default?.nativeBuildVersion;
    return parseBuildNumber(raw);
  } catch {
    return null;
  }
}

function parseBuildNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Fetch the latest field build metadata from the web app. Returns `null` when
 * the server has no build deployed (404) or the service is unavailable (503) —
 * both mean "no update to show". Throws on a network failure so the provider
 * can record a non-blocking error banner. `fetchImpl` is injected for tests.
 */
export async function fetchLatestFieldVersion(
  fetchImpl: typeof fetch,
): Promise<LatestFieldVersion | null> {
  const base = normalizeServerUrl(fieldEnv.defaultServerUrl);
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/field/version`, { method: "GET" });
  } catch {
    throw new Error("Could not reach the server to check for field app updates.");
  }
  if (res.status === 404 || res.status === 503) return null;
  if (!res.ok) {
    throw new Error(`Version check failed (HTTP ${res.status}).`);
  }
  const body = (await res.json()) as { buildNumber?: number; installUrl?: string };
  if (typeof body.buildNumber !== "number" || typeof body.installUrl !== "string") {
    throw new Error("Version check response was malformed.");
  }
  return { buildNumber: body.buildNumber, installUrl: body.installUrl };
}
