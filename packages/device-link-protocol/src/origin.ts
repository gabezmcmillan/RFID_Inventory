/**
 * Strict validator for a QR-embedded Field API device origin.
 *
 * Unlike the manual Settings URL policy (`validateServerUrl`, which permits
 * plain HTTP for loopback/private hosts), a device origin embedded in the
 * link QR MUST be an exact HTTPS origin: scheme `https`, a hostname, default
 * port (no explicit port), and NO username/password, path, query, or hash.
 * The QR is scanned on a physical device over an untrusted transport, so it
 * can only carry a private tailnet HTTPS origin (or an approved reserved
 * ngrok HTTPS endpoint as a fallback).
 *
 * Pure (no I/O, no React Native imports).
 */

/** Outcome of {@link validateDeviceApiOrigin}: an exact HTTPS origin or an error. */
export interface OriginValidation {
  ok: boolean;
  /** The exact HTTPS origin (`https://host`) when `ok`. */
  origin?: string;
  /** User-facing reason when `!ok`. */
  error?: string;
}

/** Maximum accepted length of a raw device-origin string (defense vs. abuse). */
export const MAX_DEVICE_ORIGIN_LENGTH = 256;

/**
 * Validate a raw device-origin string as an exact HTTPS origin. Rejects
 * credentials, explicit ports, paths, queries, hashes, and non-HTTPS schemes.
 * Returns the canonical `https://host` origin on success.
 */
export function validateDeviceApiOrigin(raw: string): OriginValidation {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Device API origin is empty." };
  }
  if (trimmed.length > MAX_DEVICE_ORIGIN_LENGTH) {
    return { ok: false, error: "Device API origin is too long." };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Device API origin is not a valid URL." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Device API origin must use HTTPS." };
  }
  if (!parsed.hostname) {
    return { ok: false, error: "Device API origin is missing a host." };
  }
  // An exact origin carries no credentials, port, path, query, or hash.
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Device API origin must not contain credentials." };
  }
  if (parsed.port !== "") {
    return { ok: false, error: "Device API origin must not specify an explicit port." };
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    return { ok: false, error: "Device API origin must be an exact origin with no path, query, or hash." };
  }
  return { ok: true, origin: `${parsed.protocol}//${parsed.hostname}` };
}
