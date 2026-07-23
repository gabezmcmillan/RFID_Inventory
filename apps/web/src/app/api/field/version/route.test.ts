import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { getLatest, parseBn } = vi.hoisted(() => ({
  getLatest: vi.fn(),
  parseBn: vi.fn(),
}));

vi.mock("@/lib/fieldVersion", () => ({
  getLatestFieldVersion: getLatest,
  parseBuildNumber: parseBn,
}));

import { GET as versionRoute } from "@/app/api/field/version/route";

const REQ = new Request("https://rfid.example/api/field/version");

describe("GET /api/field/version", () => {
  beforeEach(() => {
    getLatest.mockReset();
    parseBn.mockReset();
    process.env.BLOB_READ_WRITE_TOKEN = "rw-tok";
  });
  afterEach(() => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
  });

  test("returns the latest build number + install page URL on 200", async () => {
    getLatest.mockResolvedValue({
      buildNumber: "42",
      marketingVersion: "1.0.0",
      bundleId: "com.brasfieldgorrie.rfid-field",
      displayName: "RFID Field",
      ipaPath: "field-ios/1.0.0/42.ipa",
      uploadedAt: "2026-07-23T15:00:00Z",
    });
    parseBn.mockReturnValue(42);
    const res = await versionRoute(REQ);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { buildNumber: number; marketingVersion: string; installUrl: string };
    expect(body.buildNumber).toBe(42);
    expect(body.marketingVersion).toBe("1.0.0");
    expect(body.installUrl).toBe("https://rfid.example/field/install");
  });

  test("404 when configured but no build deployed", async () => {
    getLatest.mockResolvedValue(null);
    const res = await versionRoute(REQ);
    expect(res.status).toBe(404);
  });

  test("503 when Blob is not configured", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    getLatest.mockResolvedValue(null);
    const res = await versionRoute(REQ);
    expect(res.status).toBe(503);
  });
});
