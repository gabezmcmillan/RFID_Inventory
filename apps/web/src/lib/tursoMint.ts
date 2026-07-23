/**
 * Turso database-token minting (plan 010, Phase 2). The server holds a Turso
 * Platform API token (`TURSO_MINT_TOKEN`) and mints short-lived, fine-grained
 * database tokens for field devices on demand — the phone never holds a static
 * or broad token. The phone's sync `authToken` callback fetches a fresh token
 * here; the token expires (and is re-minted) frequently.
 *
 * The Turso Platform API identifies a database by its ORGANIZATION + DATABASE
 * NAME (as shown in `turso db list`), NOT by its libSQL hostname — those don't
 * map by a simple split. So the org + database name are passed in explicitly
 * (configured server-side via `TURSO_ORG` + `TURSO_DB_NAME`), never parsed from
 * the URL.
 *
 * Endpoint: `POST https://api.turso.tech/v1/organizations/<org>/databases/<db>/auth/tokens?expiration=<sec>`
 * with `Authorization: Bearer <platformToken>`. An optional
 * `fine_grained_permissions` body narrows the token (read-only, full-access,
 * etc.).
 */

export interface MintTokenInput {
  /** The Turso Platform API token (server-only `TURSO_MINT_TOKEN`). */
  platformToken: string;
  /** The Turso organization name the database lives in (server-only `TURSO_ORG`). */
  org: string;
  /** The Turso database name (server-only `TURSO_DB_NAME`), NOT the hostname. */
  database: string;
  /** Token lifetime in seconds. */
  expirationSec: number;
  /** Optional fine-grained permissions body (e.g. `{"read_only": true}`). */
  permissions?: Record<string, unknown>;
}

export interface MintTokenResult {
  /** The minted JWT the phone uses as its sync `authToken`. */
  jwt: string;
}

/** Build the Turso Platform API request URL + headers + body for a mint. */
export function buildMintRequest(input: MintTokenInput): {
  url: string;
  init: RequestInit;
} {
  const url = `https://api.turso.tech/v1/organizations/${input.org}/databases/${input.database}/auth/tokens?expiration=${input.expirationSec}`;
  const body = input.permissions ? JSON.stringify(input.permissions) : undefined;
  return {
    url,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.platformToken}`,
        "Content-Type": "application/json",
      },
      body,
    },
  };
}

/**
 * Mint a short-lived database token from the Turso Platform API. Throws on a
 * non-OK response (the caller surfaces a 502 to the phone). Never logs the
 * returned JWT or the platform token.
 */
export async function mintSyncToken(input: MintTokenInput): Promise<MintTokenResult> {
  const { url, init } = buildMintRequest(input);
  const resp = await fetch(url, init);
  if (!resp.ok) {
    throw new Error(`Turso mint failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as { jwt?: string };
  if (!data.jwt) {
    throw new Error("Turso mint returned no jwt");
  }
  return { jwt: data.jwt };
}
