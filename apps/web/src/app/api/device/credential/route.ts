/**
 * `POST /api/device/credential` — mint a short-lived Turso sync token for the
 * caller's field device (plan 010, Phase 2). The phone's sync `authToken`
 * callback hits this with the stored bearer to get a fresh, fine-grained
 * database token; it expires frequently and is re-minted on demand.
 *
 * Checks: a valid bearer session, the user's email is on the allowlist, and
 * the device is active. An unlinked/revoked device is denied here (the phone
 * must re-link). Requires `TURSO_MINT_TOKEN` + `TURSO_DATABASE_URL` server-side.
 */

import { getAuth } from "@/lib/auth";
import { isAllowed } from "@/lib/allowlist";
import { env } from "@/lib/env";
import { getActiveDeviceForUser } from "@/lib/devices";
import { forbidden, json, resolveDeviceSession, unauthorized } from "@/lib/deviceAuth";
import { mintSyncToken } from "@/lib/tursoMint";

/** Token lifetime minted for the phone (seconds). Short; re-minted on demand. */
const SYNC_TOKEN_TTL_SEC = 5 * 60;

export async function POST(request: Request): Promise<Response> {
  const auth = getAuth();
  const session = await resolveDeviceSession(auth, request);
  if (!session) return unauthorized();

  if (!isAllowed(session.email, env.FIELD_OPERATOR_ALLOWLIST)) {
    return forbidden("Your account is not permitted to sync");
  }

  const device = await getActiveDeviceForUser(session.userId);
  if (!device) {
    // No active device (unlinked/revoked) => deny a fresh sync token.
    return forbidden("No active field device; re-link this device");
  }

  const platformToken = env.TURSO_MINT_TOKEN;
  const org = env.TURSO_ORG;
  const database = env.TURSO_DB_NAME;
  if (!platformToken || !org || !database) {
    return json({ error: "Sync token minting is not configured" }, 503);
  }

  let jwt: string;
  try {
    const result = await mintSyncToken({
      platformToken,
      org,
      database,
      expirationSec: SYNC_TOKEN_TTL_SEC,
    });
    jwt = result.jwt;
  } catch {
    return json({ error: "Failed to mint a sync token" }, 502);
  }

  return json({ token: jwt, expiresAt: SYNC_TOKEN_TTL_SEC }, 200);
}
