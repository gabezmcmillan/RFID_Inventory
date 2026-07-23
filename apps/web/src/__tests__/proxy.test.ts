import { beforeEach, describe, expect, test, vi } from "vitest";

const { getSessionCookie, devBypass } = vi.hoisted(() => ({
  getSessionCookie: vi.fn(),
  devBypass: vi.fn(),
}));

vi.mock("better-auth/cookies", () => ({ getSessionCookie }));
vi.mock("@/lib/dev-bypass", () => ({ isDevBypassActive: devBypass }));

import { proxy } from "@/proxy";
import { NextRequest } from "next/server";

function req(pathname: string, method = "GET"): NextRequest {
  return new NextRequest(`https://rfid.example${pathname}`, { method });
}

/** A `proxy` response that lets the request through. */
function passes(res: { status: number }): boolean {
  // NextResponse.next() returns status 200 with no Location header.
  return res.status === 200;
}

/** A `proxy` redirect to /sign-in. */
function redirectsToSignIn(res: { status: number; headers: Headers }): boolean {
  return res.status === 307 && res.headers.get("location") === "https://rfid.example/sign-in";
}

describe("proxy — auth gate", () => {
  beforeEach(() => {
    getSessionCookie.mockReset();
    devBypass.mockReset();
    devBypass.mockReturnValue(false);
  });

  describe("public allowlist (no auth, no cookie)", () => {
    test.each([
      ["GET", "/sign-in"],
      ["GET", "/login"],
      ["GET", "/api/auth/sign-in/social"],
      ["GET", "/api/auth/callback/microsoft"],
      ["GET", "/api/health"],
      ["GET", "/field/install"],
      ["GET", "/api/field/manifest.plist"],
      ["GET", "/api/field/version"],
    ])("%s %s passes without a cookie", async (_m, path) => {
      const res = await proxy(req(path));
      expect(passes(res)).toBe(true);
      expect(getSessionCookie).not.toHaveBeenCalled();
    });
  });

  describe("bearer-only API (not cookie-gated)", () => {
    test.each([
      ["POST", "/api/device/credential"],
      ["POST", "/api/device/register"],
      ["POST", "/api/device/unlink"],
      ["POST", "/api/bol/upload-grant"],
    ])("%s %s passes the proxy (route enforces bearer)", async (_m, path) => {
      const res = await proxy(req(path));
      expect(passes(res)).toBe(true);
      expect(getSessionCookie).not.toHaveBeenCalled();
    });
  });

  describe("gated routes redirect to /sign-in when unauthenticated", () => {
    test.each([
      ["/"],
      ["/requests"],
      ["/warehouse"],
      ["/warehouse?group=bol"],
      ["/admin/devices"],
      ["/link-device"],
      // Formerly public — now gated per operator instruction.
      ["/tag/ABC123"],
      ["/tag/ABC123/"],
    ])("%s redirects to /sign-in", async (path) => {
      getSessionCookie.mockReturnValue(null);
      const res = (await proxy(req(path))) as unknown as { status: number; headers: Headers };
      expect(redirectsToSignIn(res)).toBe(true);
    });

    test("a gated API route redirects when unauthenticated", async () => {
      // A hypothetical cookie-gated API route (none today, but the gate covers
      // any non-allowlisted /api path).
      getSessionCookie.mockReturnValue(null);
      const res = (await proxy(req("/api/some-future-route"))) as unknown as {
        status: number;
        headers: Headers;
      };
      expect(redirectsToSignIn(res)).toBe(true);
    });
  });

  describe("authenticated requests pass the gate", () => {
    test("a request with a session cookie passes a gated route", async () => {
      getSessionCookie.mockReturnValue("session-cookie-value");
      const res = await proxy(req("/"));
      expect(passes(res)).toBe(true);
    });

    test("a request with a session cookie passes /tag/{epc}", async () => {
      getSessionCookie.mockReturnValue("session-cookie-value");
      const res = await proxy(req("/tag/ABC123"));
      expect(passes(res)).toBe(true);
    });
  });

  describe("dev bypass", () => {
    test("the dev bypass lets an unauthenticated gated route through", async () => {
      devBypass.mockReturnValue(true);
      const res = await proxy(req("/"));
      expect(passes(res)).toBe(true);
      expect(getSessionCookie).not.toHaveBeenCalled();
    });
  });
});
