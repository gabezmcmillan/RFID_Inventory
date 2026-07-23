/**
 * Field iOS build version helpers (plan 010, Phase 5 — enterprise in-house
 * distribution). The CI deploy job uploads the signed IPA to the private
 * `rfid-bol` Blob store at `field-ios/{marketingVersion}/{buildNumber}.ipa`
 * and a small `field-ios/latest.json` describing it; this module reads that
 * latest-version metadata server-side so the web can tell field devices whether
 * a newer build exists.
 *
 * The store is private, so `latest.json` is read via a short-lived presigned GET
 * URL (the {@link presignedGetUrl} helper shared with the BOL tag page) — the
 * read-write token never leaves the server. The IPA itself is likewise served to
 * iOS via a presigned GET URL minted by the manifest route at install time.
 */

import { presignedGetUrl } from "@/lib/bolBlob";

/** Pathname of the latest-version metadata object in the Blob store. */
export const FIELD_LATEST_PATHNAME = "field-ios/latest.json";

/** Shape of the `latest.json` the CI deploy job writes. */
export interface FieldLatestVersion {
  /** The build number (CI run number) as a string, e.g. "42". */
  buildNumber: string;
  /** The marketing version from `app.json` `expo.version`, e.g. "1.0.0". */
  marketingVersion: string;
  /** The bundle ID the IPA was signed with. */
  bundleId: string;
  /** The human-readable app name for the manifest title. */
  displayName: string;
  /** The IPA's Blob pathname (for the manifest `software-package` URL). */
  ipaPath: string;
  /** ISO timestamp of the deploy. */
  uploadedAt: string;
}

function isLatestVersion(v: unknown): v is FieldLatestVersion {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.buildNumber === "string" &&
    typeof o.marketingVersion === "string" &&
    typeof o.bundleId === "string" &&
    typeof o.displayName === "string" &&
    typeof o.ipaPath === "string" &&
    typeof o.uploadedAt === "string"
  );
}

/**
 * Read the latest field iOS build metadata from the Blob store. Returns `null`
 * when Blob is not configured or no build has been deployed yet (the field app
 * then shows no update banner). Throws only on a malformed `latest.json`
 * (surfaces as a 500 from the route).
 */
export async function getLatestFieldVersion(): Promise<FieldLatestVersion | null> {
  const getUrl = await presignedGetUrl(FIELD_LATEST_PATHNAME);
  if (!getUrl) return null;
  let res: Response;
  try {
    res = await fetch(getUrl, { cache: "no-store" });
  } catch {
    // Blob store misconfigured / unreachable — treat as "no build available".
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`latest.json fetch failed (${res.status})`);
  const body = (await res.json()) as unknown;
  if (!isLatestVersion(body)) throw new Error("latest.json is malformed");
  return body;
}

/** Parse a build number string into an integer, or `null` if not a positive int. */
export function parseBuildNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Escape a string for safe inclusion in an XML plist text node/attribute. */
function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Build the iOS OTA install `manifest.plist` for the latest field build. The
 * `software-package` URL is a short-lived presigned GET URL for the IPA in the
 * private Blob store — iOS fetches it with a plain HTTPS GET (no cookies/auth),
 * which is why the manifest route mints a fresh presigned URL on each request.
 */
export function buildInstallManifestPlist(input: {
  ipaUrl: string;
  bundleId: string;
  bundleVersion: string;
  title: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${escapeXml(input.ipaUrl)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${escapeXml(input.bundleId)}</string>
        <key>bundle-version</key>
        <string>${escapeXml(input.bundleVersion)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${escapeXml(input.title)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}
