/**
 * `@rfid/device-link-protocol` — the pure TypeScript device-link QR protocol
 * shared by the web app (`/link-device` emitter) and the field app (scanner).
 *
 * v1 payload: `{ v: 1, token, deviceApiOrigin }`. The token is Better Auth's
 * single-use one-time token; `deviceApiOrigin` is non-secret configuration
 * (the private Tailscale HTTPS Field API origin). A legacy bare-token QR is
 * still accepted so an installed pre-v1 dev client keeps working (it exchanges
 * against the phone's already-trusted manual origin and cannot switch origin).
 *
 * No React Native imports — runs in Node (tests) and RN.
 */

export {
  DEVICE_LINK_PAYLOAD_VERSION,
  encodeDeviceLinkPayload,
  MAX_PAYLOAD_LENGTH,
  MAX_TOKEN_LENGTH,
  parseDeviceLinkPayload,
  type DeviceLinkPayloadV1,
  type EncodeDeviceLinkInput,
  type ParseResult,
} from "./payload.js";

export {
  isLocalPrivateHost,
  normalizeServerUrl,
  validateServerUrl,
  type ServerUrlValidation,
} from "./url.js";

export {
  MAX_DEVICE_ORIGIN_LENGTH,
  validateDeviceApiOrigin,
  type OriginValidation,
} from "./origin.js";
