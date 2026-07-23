/**
 * `GET /api/field/manifest.plist` — iOS OTA install manifest for the latest
 * field build (plan 010, Phase 5). Returns the `manifest.plist` with the
 * correct XML content-type; the `software-package` URL is a short-lived
 * presigned GET URL for the IPA in the private Blob store (minted per request).
 *
 * The `itms-services://` install link on `/field/install` points here. iOS
 * fetches this manifest with a plain HTTPS GET (no cookies/auth), reads the
 * IPA URL, then downloads the IPA bytes directly from Blob storage — the IPA
 * never proxies through a Next.js route (the body cap + double bandwidth would
 * defeat the point). Public (no auth): a fresh phone has no session.
 */

import { presignedGetUrl } from "@/lib/bolBlob";
import { buildInstallManifestPlist, getLatestFieldVersion } from "@/lib/fieldVersion";
import { json } from "@/lib/deviceAuth";

export async function GET(): Promise<Response> {
  const latest = await getLatestFieldVersion();
  if (!latest) {
    return json({ error: "no field build deployed" }, 404);
  }
  const ipaUrl = await presignedGetUrl(latest.ipaPath);
  if (!ipaUrl) {
    return json({ error: "field distribution is not configured" }, 503);
  }
  const plist = buildInstallManifestPlist({
    ipaUrl,
    bundleId: latest.bundleId,
    bundleVersion: latest.marketingVersion,
    title: latest.displayName,
  });
  return new Response(plist, {
    status: 200,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
