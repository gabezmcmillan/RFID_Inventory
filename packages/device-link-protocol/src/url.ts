/**
 * Pure URL helpers shared by the field Settings UI and the device-link QR
 * validator. Moved out of `apps/field/src/auth/credential.ts` so the manual
 * Settings URL policy and the stricter QR origin policy cannot drift apart.
 *
 * `validateServerUrl` is the MANUAL Settings policy: it allows plain HTTP for
 * loopback / RFC1918 / link-local / `.local` / `.localhost` hosts (a physical
 * dev iPhone on the same Wi-Fi as the Mac), and requires HTTPS for anything
 * else. The QR device-origin validator (`validateDeviceApiOrigin`) is stricter:
 * HTTPS only, no userinfo/path/query/hash.
 *
 * No I/O, no React Native imports — safe to run in Node (tests) and RN.
 */

/** Outcome of {@link validateServerUrl}: a normalized URL or a user-facing error. */
export interface ServerUrlValidation {
  ok: boolean;
  /** Whitespace- and trailing-slash-trimmed URL when `ok`. */
  normalized?: string;
  /** Whether the host is loopback / private / link-local (HTTP allowed only then). */
  isPrivate?: boolean;
  /** User-facing reason when `!ok`. */
  error?: string;
}

/**
 * Trim whitespace and trailing slashes from a URL-ish string. Does NOT validate
 * — use {@link validateServerUrl} for that. Pure (no I/O).
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

/**
 * Validate a user-entered web server URL (the manual Settings policy): require
 * http/https, reject malformed URLs, and allow plain HTTP only for local/private
 * dev hosts (production must use HTTPS). Returns a normalized URL on success.
 * Pure (no I/O).
 */
export function validateServerUrl(input: string): ServerUrlValidation {
  const normalized = normalizeServerUrl(input);
  if (normalized.length === 0) {
    return { ok: false, error: "Enter a URL, e.g. http://10.1.81.56:3001" };
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, error: "Invalid URL. It must start with http:// or https://" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "URL must start with http:// or https://" };
  }
  if (!parsed.hostname) {
    return { ok: false, error: "URL is missing a host." };
  }
  const isPrivate = isLocalPrivateHost(parsed.hostname);
  if (parsed.protocol === "http:" && !isPrivate) {
    return {
      ok: false,
      normalized,
      isPrivate,
      error: "Plain HTTP is only allowed for local/private dev hosts. Use HTTPS for production.",
    };
  }
  return { ok: true, normalized, isPrivate };
}
