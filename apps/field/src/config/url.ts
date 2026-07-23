/**
 * Pure URL helpers shared by the field env seam (`config/env.ts`) and the
 * stored-credential module (`auth/credential.ts`). No React, no `process.env`,
 * no storage — safe to unit-test and to import from anywhere without cycles.
 *
 * Two distinct validation policies live here on purpose (they validate
 * different inputs, so they do not conflict):
 *   - {@link validateOriginUrl}: an EXACT http/https ORIGIN (no credentials,
 *     path, query, or hash) — used for the machine-configured Expo env default.
 *   - {@link isLocalPrivateHost}: the shared "plain HTTP is allowed only for
 *     local/private hosts" rule, reused by both the origin validator and the
 *     user-typed Settings URL validator in `credential.ts`.
 */

/** Strip a single trailing dot from a DNS name (Tailscale DNSNames end with "."). */
export function stripTrailingDot(name: string): string {
  if (typeof name !== "string") return "";
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

/**
 * Trim whitespace and trailing slashes from a URL-ish string. Does NOT
 * validate — use {@link validateOriginUrl} / `validateServerUrl` for that.
 * Pure (no I/O).
 */
export function normalizeServerUrl(input: string): string {
  return input.trim().replace(/\/+$/, "");
}

/**
 * Whether `hostname` is a loopback, private (RFC1918), or link-local address,
 * or a `.local`/`.localhost` mDNS name — i.e. a host for which plain HTTP is
 * acceptable in development. Pure (no I/O).
 */
export function isLocalPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().trim();
  if (h === "") return false;
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local")) return true;
  // IPv4 dotted-quad private / link-local ranges.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  }
  return false;
}

/** Outcome of {@link validateOriginUrl}. */
export interface OriginValidation {
  ok: boolean;
  /** Whitespace- and trailing-slash-trimmed origin when `ok`. */
  origin?: string;
  /** Whether the host is loopback/private/link-local (HTTP allowed only then). */
  isPrivate?: boolean;
  /** User-facing reason when `!ok` (never echoes the input value). */
  error?: string;
}

/**
 * Validate an EXACT http/https ORIGIN: require `http:` or `https:`, a hostname,
 * and NO credentials, path, query, or hash. Plain HTTP is allowed only for
 * local/private dev hosts (the {@link isLocalPrivateHost} rule); production
 * and Tailscale HTTPS origins are allowed. Returns the normalized origin
 * (`https://host`) on success.
 *
 * This is stricter than the user-typed Settings URL validator in
 * `credential.ts` (which permits paths) — the Expo env default is a
 * machine-configured base origin, not a user-typed URL. Error messages never
 * echo the input value. Pure (no I/O).
 */
export function validateOriginUrl(input: string): OriginValidation {
  const normalized = normalizeServerUrl(input);
  if (normalized.length === 0) {
    return { ok: false, error: "Enter an origin, e.g. https://machine.tailnet.ts.net" };
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, error: "Invalid origin. It must start with http:// or https://" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Origin must start with http:// or https://" };
  }
  if (!parsed.hostname) {
    return { ok: false, error: "Origin is missing a host." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Origin must not contain credentials (user:pass@)." };
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    return { ok: false, error: "Origin must not contain a path." };
  }
  if (parsed.search) {
    return { ok: false, error: "Origin must not contain a query string." };
  }
  if (parsed.hash) {
    return { ok: false, error: "Origin must not contain a fragment." };
  }
  const isPrivate = isLocalPrivateHost(parsed.hostname);
  if (parsed.protocol === "http:" && !isPrivate) {
    return {
      ok: false,
      isPrivate,
      error: "Plain HTTP is only allowed for local/private dev hosts. Use HTTPS for production.",
    };
  }
  // Reconstruct a clean origin so trailing slashes / default ports normalize away.
  return { ok: true, origin: `${parsed.protocol}//${parsed.host}`, isPrivate };
}
