/**
 * Device-link QR payload protocol (v1).
 *
 * The web app's `/link-device` page mints a single-use, 5-minute Better Auth
 * one-time token server-side and encodes it together with the separately-named
 * Field API origin (`FIELD_DEVICE_API_ORIGIN`) as a compact JSON object:
 *
 *   { "v": 1, "token": "<one-time-token>", "deviceApiOrigin": "https://<machine>.<tailnet>.ts.net" }
 *
 * The phone scans the QR, parses the payload, and — if the embedded device
 * origin differs from its currently trusted origin — asks the user to confirm
 * the switch before exchanging the one-time token against the new origin. The
 * token is the ONLY secret in the payload; `deviceApiOrigin` is non-secret
 * configuration.
 *
 * A legacy bare-token QR (no JSON) is still recognized so an already-installed
 * dev client built before v1 keeps working: it exchanges against the phone's
 * already-trusted manual origin and can never switch origin from a legacy QR.
 *
 * Pure (no I/O, no React Native imports).
 */

import { validateDeviceApiOrigin, type OriginValidation } from "./origin.js";

/** The only payload version this protocol emits/accepts. */
export const DEVICE_LINK_PAYLOAD_VERSION = 1 as const;

/** The strict v1 payload shape (exactly these keys, nothing else). */
export interface DeviceLinkPayloadV1 {
  v: typeof DEVICE_LINK_PAYLOAD_VERSION;
  token: string;
  deviceApiOrigin: string;
}

/** Input to {@link encodeDeviceLinkPayload}. */
export interface EncodeDeviceLinkInput {
  token: string;
  deviceApiOrigin: string;
}

/** Maximum accepted lengths (defense vs. oversized/abuse input). */
export const MAX_TOKEN_LENGTH = 256;
export const MAX_PAYLOAD_LENGTH = 2048;

/** Result of {@link parseDeviceLinkPayload}. */
export type ParseResult =
  | { kind: "v1"; payload: DeviceLinkPayloadV1 }
  | { kind: "legacy"; token: string }
  | { kind: "error"; error: string };

/**
 * Encode a v1 device-link payload as compact JSON. The token and a validated
 * exact HTTPS device origin are required. Throws on invalid input so the
 * emitter (server action) fails loudly rather than minting a malformed QR.
 */
export function encodeDeviceLinkPayload(input: EncodeDeviceLinkInput): string {
  const token = input.token.trim();
  if (token.length === 0) {
    throw new Error("encodeDeviceLinkPayload: token is empty.");
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new Error("encodeDeviceLinkPayload: token is too long.");
  }
  const origin = validateDeviceApiOrigin(input.deviceApiOrigin);
  if (!origin.ok || !origin.origin) {
    throw new Error(`encodeDeviceLinkPayload: ${origin.error ?? "invalid device origin."}`);
  }
  const payload: DeviceLinkPayloadV1 = {
    v: DEVICE_LINK_PAYLOAD_VERSION,
    token,
    deviceApiOrigin: origin.origin,
  };
  return JSON.stringify(payload);
}

/**
 * Parse a raw scanned QR string into a v1 payload, a legacy bare token, or an
 * error. Never throws — callers branch on `kind`.
 *
 * - v1: valid JSON object with exactly `v:1`, a non-empty `token`, and a valid
 *   exact HTTPS `deviceApiOrigin`. Unknown versions/fields, malformed JSON,
 *   empty/oversized values, and non-HTTPS/impure origins are `error`.
 * - legacy: a non-JSON bare token (the pre-v1 QR shape). It carries no origin
 *   and can never switch the phone's trusted origin.
 */
export function parseDeviceLinkPayload(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "error", error: "QR is empty." };
  }
  if (trimmed.length > MAX_PAYLOAD_LENGTH) {
    return { kind: "error", error: "QR payload is too large." };
  }
  // A v1 payload is a JSON object. A legacy bare token is not valid JSON.
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { kind: "error", error: "QR is malformed." };
    }
    return parseV1Object(parsed);
  }
  // Legacy bare-token QR: exchange against the phone's already-trusted origin.
  if (trimmed.length > MAX_TOKEN_LENGTH) {
    return { kind: "error", error: "QR token is too long." };
  }
  return { kind: "legacy", token: trimmed };
}

function parseV1Object(parsed: unknown): ParseResult {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "error", error: "QR payload is not an object." };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== DEVICE_LINK_PAYLOAD_VERSION) {
    return { kind: "error", error: "Unsupported QR payload version." };
  }
  // Reject unknown fields: the v1 shape is exactly {v, token, deviceApiOrigin}.
  const knownKeys = new Set(["v", "token", "deviceApiOrigin"]);
  for (const key of Object.keys(obj)) {
    if (!knownKeys.has(key)) {
      return { kind: "error", error: "QR payload has unknown fields." };
    }
  }
  const token = obj.token;
  const deviceApiOrigin = obj.deviceApiOrigin;
  if (typeof token !== "string" || token.trim().length === 0) {
    return { kind: "error", error: "QR payload is missing a token." };
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return { kind: "error", error: "QR payload token is too long." };
  }
  if (typeof deviceApiOrigin !== "string") {
    return { kind: "error", error: "QR payload is missing a device API origin." };
  }
  const origin: OriginValidation = validateDeviceApiOrigin(deviceApiOrigin);
  if (!origin.ok || !origin.origin) {
    return { kind: "error", error: origin.error ?? "Invalid device API origin." };
  }
  return {
    kind: "v1",
    payload: { v: DEVICE_LINK_PAYLOAD_VERSION, token, deviceApiOrigin: origin.origin },
  };
}
