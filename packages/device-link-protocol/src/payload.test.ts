import { describe, expect, test } from "vitest";

import {
  DEVICE_LINK_PAYLOAD_VERSION,
  encodeDeviceLinkPayload,
  MAX_DEVICE_ORIGIN_LENGTH,
  MAX_PAYLOAD_LENGTH,
  MAX_TOKEN_LENGTH,
  parseDeviceLinkPayload,
  validateDeviceApiOrigin,
  validateServerUrl,
} from "./index.js";

const TAILSCALE_ORIGIN = "https://mac.tailc66d9.ts.net";
const NGROK_ORIGIN = "https://rfid-field-dev.ngrok.app";
const TOKEN = "ott_abcdef1234567890";

describe("device-link payload v1", () => {
  test("round-trips the exact {v,token,deviceApiOrigin} keys", () => {
    const encoded = encodeDeviceLinkPayload({ token: TOKEN, deviceApiOrigin: TAILSCALE_ORIGIN });
    const parsed = parseDeviceLinkPayload(encoded);
    expect(parsed).toEqual({
      kind: "v1",
      payload: {
        v: DEVICE_LINK_PAYLOAD_VERSION,
        token: TOKEN,
        deviceApiOrigin: TAILSCALE_ORIGIN,
      },
    });
    // Exactly three keys, no extras.
    const obj = JSON.parse(encoded) as Record<string, unknown>;
    expect(Object.keys(obj).sort()).toEqual(["deviceApiOrigin", "token", "v"]);
  });

  test("keeps Web/SSO localhost and the HTTPS Field API origin distinct", () => {
    const web = validateServerUrl("http://localhost:3000");
    expect(web.ok).toBe(true);
    const field = validateDeviceApiOrigin(TAILSCALE_ORIGIN);
    expect(field.ok).toBe(true);
    expect(field.origin).not.toBe(web.normalized);
  });

  test("normalizes a .ts.net HTTPS origin (strips trailing slash, keeps https)", () => {
    const encoded = encodeDeviceLinkPayload({
      token: TOKEN,
      deviceApiOrigin: "https://Mac.tailc66d9.ts.net/",
    });
    const parsed = parseDeviceLinkPayload(encoded);
    expect(parsed.kind).toBe("v1");
    if (parsed.kind === "v1") {
      // URL lowercases the hostname; the trailing slash is stripped.
      expect(parsed.payload.deviceApiOrigin).toBe("https://mac.tailc66d9.ts.net");
    }
  });

  test("accepts an approved reserved ngrok HTTPS fallback as Field API only", () => {
    const encoded = encodeDeviceLinkPayload({ token: TOKEN, deviceApiOrigin: NGROK_ORIGIN });
    const parsed = parseDeviceLinkPayload(encoded);
    expect(parsed.kind).toBe("v1");
    if (parsed.kind === "v1") {
      expect(parsed.payload.deviceApiOrigin).toBe(NGROK_ORIGIN);
      // It must never be a valid Web/SSO origin (localhost is HTTP).
      expect(parsed.payload.deviceApiOrigin).not.toBe("http://localhost:3000");
    }
  });

  test("rejects HTTP, userinfo, path, query, hash, and explicit port", () => {
    const bad = [
      "http://mac.tailc66d9.ts.net",
      "https://user:pass@mac.tailc66d9.ts.net",
      "https://mac.tailc66d9.ts.net/api",
      "https://mac.tailc66d9.ts.net?x=1",
      "https://mac.tailc66d9.ts.net#frag",
      "https://mac.tailc66d9.ts.net:8443",
      "ftp://mac.tailc66d9.ts.net",
    ];
    for (const origin of bad) {
      expect(validateDeviceApiOrigin(origin).ok).toBe(false);
    }
  });

  test("rejects malformed JSON, unknown version, unknown fields, empty/oversized token", () => {
    expect(parseDeviceLinkPayload("{not json").kind).toBe("error");
    expect(parseDeviceLinkPayload('{"v":2,"token":"x","deviceApiOrigin":"https://a.ts.net"}').kind).toBe(
      "error",
    );
    expect(
      parseDeviceLinkPayload(
        `{"v":1,"token":"x","deviceApiOrigin":"${TAILSCALE_ORIGIN}","extra":1}`,
      ).kind,
    ).toBe("error");
    expect(
      parseDeviceLinkPayload(`{"v":1,"token":"","deviceApiOrigin":"${TAILSCALE_ORIGIN}"}`).kind,
    ).toBe("error");
    const huge = "x".repeat(MAX_TOKEN_LENGTH + 1);
    expect(
      parseDeviceLinkPayload(
        JSON.stringify({ v: 1, token: huge, deviceApiOrigin: TAILSCALE_ORIGIN }),
      ).kind,
    ).toBe("error");
  });

  test("rejects an empty and an oversized QR payload", () => {
    expect(parseDeviceLinkPayload("   ").kind).toBe("error");
    expect(parseDeviceLinkPayload("x".repeat(MAX_PAYLOAD_LENGTH + 1)).kind).toBe("error");
  });

  test("manual loopback/RFC1918 HTTP remains a separate (Settings) policy", () => {
    // The strict QR validator rejects HTTP even for loopback...
    expect(validateDeviceApiOrigin("http://127.0.0.1:3000").ok).toBe(false);
    // ...but the manual Settings policy still allows private-LAN HTTP.
    expect(validateServerUrl("http://10.1.81.56:3001").ok).toBe(true);
    expect(validateServerUrl("http://192.168.1.10:3000").ok).toBe(true);
    expect(validateServerUrl("http://example.com").ok).toBe(false);
  });

  test("a legacy bare-token QR cannot carry or switch origin", () => {
    const parsed = parseDeviceLinkPayload(TOKEN);
    expect(parsed).toEqual({ kind: "legacy", token: TOKEN });
    // A legacy QR carries no origin field by construction.
    if (parsed.kind === "legacy") {
      expect("deviceApiOrigin" in parsed).toBe(false);
    }
  });

  test("BETTER_AUTH_URL can never be replaced with the device origin", () => {
    // The two origins are intentionally distinct types; a config that sets the
    // device origin to localhost must be rejected by the strict validator
    // (localhost is HTTP, not HTTPS), and localhost can never be a device origin.
    expect(validateDeviceApiOrigin("http://localhost:3000").ok).toBe(false);
    // And the device origin is never the Web/SSO origin.
    const field = validateDeviceApiOrigin(TAILSCALE_ORIGIN);
    expect(field.ok).toBe(true);
    expect(field.origin).not.toBe("http://localhost:3000");
  });

  test("encode rejects an over-long device origin", () => {
    const tooLong = `https://${"x".repeat(MAX_DEVICE_ORIGIN_LENGTH)}.ts.net`;
    expect(() => encodeDeviceLinkPayload({ token: TOKEN, deviceApiOrigin: tooLong })).toThrow();
  });
});
