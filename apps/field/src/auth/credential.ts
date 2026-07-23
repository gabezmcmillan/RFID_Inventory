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
 * (dev default `http://localhost:3000` — set it to the Mac's LAN IP for a
 * physical device, since a phone cannot reach the Mac's `localhost`).
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

/** AsyncStorage key for the web app base URL (config, not secret). */
export const SERVER_URL_KEY = "rfid.field.serverUrl";
/** Default web app URL — works in the iOS simulator (host's localhost). */
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

/** Load the configured web app base URL (default when unset/empty). */
export async function getServerUrl(): Promise<string> {
  const v = await AsyncStorage.getItem(SERVER_URL_KEY);
  const url = (v ?? "").trim();
  return url.length > 0 ? url : DEFAULT_SERVER_URL;
}

/** Persist the web app base URL (empty restores the default). */
export async function setServerUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(SERVER_URL_KEY, url.trim());
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
 * on any non-2xx so the caller can surface the message.
 */
export async function exchangeOneTimeToken(
  serverUrl: string,
  oneTimeToken: string,
): Promise<LinkedCredential> {
  const base = serverUrl.trim().replace(/\/+$/, "");
  const res = await fetch(`${base}/api/auth/one-time-token/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: oneTimeToken }),
  });
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

/** Unlink the device: clear the stored bearer token and identity. */
export async function clearLinkedCredential(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(LINK_TOKEN_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(LINK_IDENTITY_KEY).catch(() => {}),
  ]);
}
