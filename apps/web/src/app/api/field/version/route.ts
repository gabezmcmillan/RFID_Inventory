/**
 * `GET /api/field/version` — latest field iOS build metadata (plan 010, Phase 5).
 *
 * The field app calls this on launch + foreground (with connectivity) to decide
 * whether a newer enterprise build is available. Returns the latest build
 * number + the install-page URL. Public (no auth): a fresh phone has no
 * session, and the only data exposed is a build number + a link to the install
 * page — no tokens, no user data. Returns 503 when Blob is not configured and
 * 404 when no build has been deployed yet.
 */

import { json } from "@/lib/deviceAuth";
import { getLatestFieldVersion, parseBuildNumber } from "@/lib/fieldVersion";

export async function GET(request: Request): Promise<Response> {
  const latest = await getLatestFieldVersion();
  if (!latest) {
    // No build deployed (or Blob misconfigured). Distinguish: 503 if Blob is
    // entirely unconfigured, 404 if configured but no latest.json yet. Both are
    // "no update available" to the field app; the status lets the banner logic
    // tell "not deployed" from "service down".
    const configured = process.env.BLOB_READ_WRITE_TOKEN;
    if (!configured) return json({ error: "field version is not configured" }, 503);
    return json({ error: "no field build deployed" }, 404);
  }
  const buildNumber = parseBuildNumber(latest.buildNumber);
  const origin = new URL(request.url).origin;
  return json(
    {
      buildNumber,
      marketingVersion: latest.marketingVersion,
      installUrl: `${origin}/field/install`,
    },
    200,
  );
}
