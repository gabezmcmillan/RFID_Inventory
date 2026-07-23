/**
 * Field device-linking auth — the phone-side half of the QR one-time-code flow.
 *
 * A signed-in web user generates a single-use, 5-minute one-time token (Better
 * Auth `oneTimeToken` plugin) rendered as a QR at `/link-device`. The phone
 * scans it (see `apps/field/app/link-device.tsx`) and exchanges it here via
 * {@link exchangeOneTimeToken}: a POST to the web app's
 * `/api/auth/one-time-token/verify` returns a freshly-minted session for the
 * SAME user (the cookie is NOT set — `disableSetSessionCookie` — so the phone,
 * which has no cookie jar, receives the session `token` in the body). That
 * session token is the long-lived credential the phone stores in
 * `expo-secure-store` and sends as `Authorization: Bearer <token>` on future
 * sync requests (the web app's `bearer` plugin resolves it to a session).
 *
 * The field app has no server sync yet (plan 010 pending), so the deliverable
 * is the link/store/display/unlink loop plus this module exposing the stored
 * credential for future sync use. The server URL is configurable in Settings
 * (dev default `http://localhost:3000` — only works in the iOS simulator,
 * where the phone shares the Mac's `localhost`; on a physical device set it to
 * the Mac's LAN IP, e.g. `http://10.1.81.56:3001`, on the same Wi-Fi).
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { fieldEnv } from "../config/env";
import { isLocalPrivateHost, normalizeServerUrl } from "../config/url";

/** AsyncStorage key for the web app base URL (config, not secret). */
export const SERVER_URL_KEY = "rfid.field.serverUrl";
/**
 * Default web app URL — read from the typed env seam (`config/env.ts`), which
 * validates `EXPO_PUBLIC_DEFAULT_SERVER_URL` (an exact http/https origin) and
 * falls back to `http://localhost:3000` for the simulator. `pnpm tailscale:setup`
 * writes this key into `apps/field/.env.local`. Re-exported here so existing
 * callers keep one import surface.
 */
export const DEFAULT_SERVER_URL = fieldEnv.defaultServerUrl;

// Re-export the pure URL helpers so the existing auth barrel (`src/auth/index.ts`)
// keeps one import surface; the canonical definitions live in `config/url.ts`.
export { isLocalPrivateHost, normalizeServerUrl } from "../config/url";

/** Secure-store key for the linked session bearer token (the secret). */
const LINK_TOKEN_KEY = "rfid.link.token";
/** Secure-store key for the linked user identity (name/email) for display. */
const LINK_IDENTITY_KEY = "rfid.link.identity";
/** Secure-store key for the server-assigned device id (UUID; for display/unlink). */
const LINK_DEVICE_ID_KEY = "rfid.link.deviceId";
/** Secure-store key for the server-assigned 2-hex EPC device byte (for display). */
const LINK_EPC_BYTE_KEY = "rfid.link.epcByte";

/** The signed-in identity mirrored from the web session, for Settings display. */
export interface LinkedIdentity {
  name: string;
  email: string;
}

/** The stored credential: the bearer token plus the identity it belongs to. */
export interface LinkedCredential {
  token: string;
  identity: LinkedIdentity;
}

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

/** Result of {@link testServerConnection}: a clear success/failure message. */
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

/**
 * Trim whitespace and trailing slashes from a URL-ish string. Does NOT
 * validate — use {@link validateServerUrl} for that. Pure (no I/O).
 *
 * Canonical definition moved to `config/url.ts`; re-exported above.
 */

/**
 * Whether `hostname` is a loopback, private (RFC1918), or link-local address,
 * or a `.local`/`.localhost` mDNS name — i.e. a host for which plain HTTP is
 * acceptable in development. Pure (no I/O).
 *
 * Canonical definition moved to `config/url.ts`; re-exported above.
 */

/**
 * Validate a user-entered web server URL: require http/https, reject malformed
 * URLs, and allow plain HTTP only for local/private dev hosts (production must
 * use HTTPS). Returns a normalized URL on success. Pure (no I/O).
 *
 * Unlike {@link validateOriginUrl} (used for the env default), this permits a
 * path — the Settings field accepts full URLs, not bare origins.
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

/**
 * Concise, actionable message for a "can't reach the server" failure (network
 * error, DNS, refused connection, ATS blocking plain HTTP, etc.). Never exposes
 * the raw `ExpoModulesCore`/`Network request failed` exception to the user.
 */
export function unreachableServerMessage(url: string): string {
  return (
    `Cannot reach ${url} from this iPhone. Set Web server URL in Settings to your Mac's ` +
    `LAN address (same Wi-Fi), e.g. http://10.1.81.56:3001, or use the production HTTPS URL.`
  );
}

/** Load the configured web app base URL (default when unset/empty). */
export async function getServerUrl(): Promise<string> {
  const v = await AsyncStorage.getItem(SERVER_URL_KEY);
  const url = normalizeServerUrl(v ?? "");
  return url.length > 0 ? url : DEFAULT_SERVER_URL;
}

/**
 * Persist the web app base URL. The value is normalized (trim + trailing
 * slash). Malformed URLs are rejected with the validation error — callers
 * should validate first (or use {@link trySetServerUrl}) so the user sees the
 * reason. Empty restores the default.
 */
export async function setServerUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(SERVER_URL_KEY, normalizeServerUrl(url));
}

/**
 * Validate then persist a server URL. Returns the validation outcome so the
 * Settings UI can surface the error without a second parse. Does NOT persist
 * malformed values.
 */
export async function trySetServerUrl(
  url: string,
): Promise<ServerUrlValidation> {
  const v = validateServerUrl(url);
  if (v.ok && v.normalized) {
    await AsyncStorage.setItem(SERVER_URL_KEY, v.normalized);
  }
  return v;
}

/** The stored bearer token, or null when no device is linked. */
export async function getLinkedToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(LINK_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** The stored linked identity, or null when no device is linked. */
export async function getLinkedIdentity(): Promise<LinkedIdentity | null> {
  try {
    const raw = await SecureStore.getItemAsync(LINK_IDENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LinkedIdentity>;
    if (typeof parsed.name === "string" && typeof parsed.email === "string") {
      return { name: parsed.name, email: parsed.email };
    }
    return null;
  } catch {
    return null;
  }
}

/** The full stored credential, or null when no device is linked. */
export async function getLinkedCredential(): Promise<LinkedCredential | null> {
  const [token, identity] = await Promise.all([getLinkedToken(), getLinkedIdentity()]);
  if (!token || !identity) return null;
  return { token, identity };
}

/** Whether a device is currently linked (a stored bearer token present). */
export async function isDeviceLinked(): Promise<boolean> {
  return (await getLinkedToken()) !== null;
}

/**
 * Exchange a scanned one-time token for a long-lived session credential and
 * store it. POSTs `{ token }` to the web app's verify endpoint; on success the
 * response body carries the new session (with its `token`) and `user`. Throws
 * a user-facing message on any failure — network errors become an actionable
 * "cannot reach" message, never the raw `ExpoModulesCore` exception.
 */
export async function exchangeOneTimeToken(
  serverUrl: string,
  oneTimeToken: string,
): Promise<LinkedCredential> {
  const base = normalizeServerUrl(serverUrl);
  let res: Response;
  try {
    res = await fetch(`${base}/api/auth/one-time-token/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: oneTimeToken }),
    });
  } catch {
    // RN fetch throws on network failure / refused connection / ATS blocking
    // plain HTTP — translate to an actionable message naming the configured URL.
    throw new Error(unreachableServerMessage(base));
  }
  if (!res.ok) {
    let message = `verify failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      /* keep the status-based message */
    }
    throw new Error(message);
  }
  const body = (await res.json()) as {
    session?: { token?: string };
    user?: { name?: string; email?: string };
  };
  const token = body.session?.token;
  const name = body.user?.name;
  const email = body.user?.email;
  if (!token || !name || !email) {
    throw new Error("verify response missing session token or user identity");
  }
  const identity: LinkedIdentity = { name, email };
  await SecureStore.setItemAsync(LINK_TOKEN_KEY, token);
  await SecureStore.setItemAsync(LINK_IDENTITY_KEY, JSON.stringify(identity));
  return { token, identity };
}

/**
 * Probe the configured server's health endpoint (`GET /api/health`) to confirm
 * the phone can reach it. Returns a clear success/failure message suitable
 * for direct UI display. Never throws — network errors become the actionable
 * "cannot reach" message.
 */
export async function testServerConnection(serverUrl: string): Promise<ConnectionTestResult> {
  const v = validateServerUrl(serverUrl);
  if (!v.ok || !v.normalized) {
    return { ok: false, message: v.error ?? "Invalid URL" };
  }
  try {
    const res = await fetch(`${v.normalized}/api/health`, { method: "GET" });
    if (!res.ok) {
      return { ok: false, message: `Server responded HTTP ${res.status}.` };
    }
    return { ok: true, message: `Connected to ${v.normalized}` };
  } catch {
    return { ok: false, message: unreachableServerMessage(v.normalized) };
  }
}

/** Unlink the device: clear the stored bearer token and identity. */
export async function clearLinkedCredential(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(LINK_TOKEN_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(LINK_IDENTITY_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(LINK_DEVICE_ID_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(LINK_EPC_BYTE_KEY).catch(() => {}),
  ]);
}

/** The server-assigned device id (UUID), or null when not linked/registered. */
export async function getLinkedDeviceId(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(LINK_DEVICE_ID_KEY);
  } catch {
    return null;
  }
}

/** The server-assigned 2-hex EPC device byte, or null when not linked/registered. */
export async function getLinkedEpcByte(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(LINK_EPC_BYTE_KEY);
  } catch {
    return null;
  }
}

/** Outcome of {@link registerDevice}: the server-assigned device id + EPC byte. */
export interface RegisteredDevice {
  deviceId: string;
  epcByte: string;
}

/**
 * Register this field device with the server (plan 010, Phase 2). Called after
 * {@link exchangeOneTimeToken} with the freshly-stored bearer. The server
 * checks the allowlist, assigns a permanent never-reused 2-hex EPC byte, and
 * returns it; we persist the device id + byte in Secure Store and write the
 * byte into the local-only device DB (so the print path embeds it in EPCs).
 * Throws a user-facing message on any failure.
 */
export async function registerDevice(
  serverUrl: string,
  bearer: string,
  label?: string,
): Promise<RegisteredDevice> {
  const base = normalizeServerUrl(serverUrl);
  let res: Response;
  try {
    res = await fetch(`${base}/api/device/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(label ? { label } : {}),
    });
  } catch {
    throw new Error(unreachableServerMessage(base));
  }
  if (!res.ok) {
    const message = await deviceErrorMessage(res);
    throw new Error(message);
  }
  const body = (await res.json()) as { deviceId?: string; epcByte?: string };
  if (!body.deviceId || !body.epcByte) {
    throw new Error("register response missing deviceId or epcByte");
  }
  const deviceId = body.deviceId;
  const epcByte = body.epcByte;
  await SecureStore.setItemAsync(LINK_DEVICE_ID_KEY, deviceId);
  await SecureStore.setItemAsync(LINK_EPC_BYTE_KEY, epcByte);
  // Write the byte into the local-only device DB so allocateEpcs embeds it.
  const { setDeviceId } = await import("../db/deviceDb");
  await setDeviceId(epcByte);
  return { deviceId, epcByte };
}

/**
 * Unlink this device from the server (plan 010, Phase 2). Tells the server to
 * mark the device inactive + revoke the session, then clears the local
 * bearer/identity/device-id and resets the local-only device DB. Best-effort:
 * local state is cleared even if the server call fails (so a lost/offline
 * device can still be reset locally). Never throws.
 */
export async function unlinkDevice(serverUrl: string, bearer: string): Promise<void> {
  const base = normalizeServerUrl(serverUrl);
  try {
    await fetch(`${base}/api/device/unlink`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
    });
  } catch {
    // Network failure — still clear local state below.
  }
  await clearLinkedCredential();
  const { resetDeviceState } = await import("../db/deviceDb");
  await resetDeviceState();
}

/** Outcome of {@link fetchSyncToken}: a short-lived Turso sync token + TTL. */
export interface SyncTokenResult {
  token: string;
  expiresAt: number;
}

/**
 * Fetch a short-lived Turso sync token from the server (plan 010, Phase 2).
 * The phone's sync `authToken` callback calls this with the stored bearer; the
 * server mints a fine-grained database token only for an active, allowlisted
 * device. Throws a user-facing message on any failure.
 */
export async function fetchSyncToken(
  serverUrl: string,
  bearer: string,
): Promise<SyncTokenResult> {
  const base = normalizeServerUrl(serverUrl);
  let res: Response;
  try {
    res = await fetch(`${base}/api/device/credential`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
    });
  } catch {
    throw new Error(unreachableServerMessage(base));
  }
  if (!res.ok) {
    const message = await deviceErrorMessage(res);
    throw new Error(message);
  }
  const body = (await res.json()) as { token?: string; expiresAt?: number };
  if (!body.token || typeof body.expiresAt !== "number") {
    throw new Error("credential response missing token or expiresAt");
  }
  return { token: body.token, expiresAt: body.expiresAt };
}

/** Extract a user-facing error message from a device-endpoint error response. */
async function deviceErrorMessage(res: Response): Promise<string> {
  let message = `request failed (${res.status})`;
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    message = body.error ?? body.message ?? message;
  } catch {
    /* keep the status-based message */
  }
  return message;
}
