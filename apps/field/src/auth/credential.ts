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

// The pure URL helpers (normalizeServerUrl / isLocalPrivateHost /
// validateServerUrl) now live in the shared `@rfid/device-link-protocol`
// package so the manual Settings URL policy and the stricter QR origin policy
// cannot drift. Re-export them here so Settings keeps its existing import
// surface (`from "../src/auth"`). The QR validator (validateDeviceApiOrigin)
// is HTTPS-only; this manual Settings policy still permits private-LAN HTTP.
import {
  normalizeServerUrl,
  validateServerUrl,
  type ServerUrlValidation,
} from "@rfid/device-link-protocol";
export {
  isLocalPrivateHost,
  normalizeServerUrl,
  validateServerUrl,
  type ServerUrlValidation,
} from "@rfid/device-link-protocol";

/** AsyncStorage key for the web app base URL (config, not secret). */
export const SERVER_URL_KEY = "rfid.field.serverUrl";
/** Default web app URL — works only in the iOS simulator (host's localhost). */
export const DEFAULT_SERVER_URL = "http://localhost:3000";

/** Secure-store key for the linked session bearer token (the secret). */
const LINK_TOKEN_KEY = "rfid.link.token";
/** Secure-store key for the linked user identity (name/email) for display. */
const LINK_IDENTITY_KEY = "rfid.link.identity";

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

/** Result of {@link testServerConnection}: a clear success/failure message. */
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
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
      // The phone has no cookie jar; explicitly omit browser cookies so the
      // one-time-token exchange against the Field API origin never carries or
      // establishes a browser session. The result is stored as a bearer token.
      credentials: "omit",
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
  ]);
}
