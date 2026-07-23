import { beforeEach, describe, expect, test, vi } from "vitest";

const { getLatest, presignedGet } = vi.hoisted(() => ({
  getLatest: vi.fn(),
  presignedGet: vi.fn(),
}));

vi.mock("@/lib/fieldVersion", () => ({
  getLatestFieldVersion: getLatest,
  buildInstallManifestPlist: (input: {
    ipaUrl: string;
    bundleId: string;
    bundleVersion: string;
    title: string;
  }) =>
    `PLIST(${input.ipaUrl}|${input.bundleId}|${input.bundleVersion}|${input.title})`,
}));
vi.mock("@/lib/bolBlob", () => ({ presignedGetUrl: presignedGet }));

import { GET as manifestRoute } from "@/app/api/field/manifest.plist/route";

const LATEST = {
  buildNumber: "42",
  marketingVersion: "1.0.0",
  bundleId: "com.brasfieldgorrie.rfid-field",
  displayName: "RFID Field",
  ipaPath: "field-ios/1.0.0/42.ipa",
  uploadedAt: "2026-07-23T15:00:00Z",
};

describe("GET /api/field/manifest.plist", () => {
  beforeEach(() => {
    getLatest.mockReset();
    presignedGet.mockReset();
  });

  test("returns the OTA manifest plist with text/xml content-type", async () => {
    getLatest.mockResolvedValue(LATEST);
    presignedGet.mockResolvedValue("https://store.private/field-ios/1.0.0/42.ipa?sig");
    const res = await manifestRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/xml");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toBe(
      "PLIST(https://store.private/field-ios/1.0.0/42.ipa?sig|com.brasfieldgorrie.rfid-field|1.0.0|RFID Field)",
    );
    expect(presignedGet).toHaveBeenCalledWith("field-ios/1.0.0/42.ipa");
  });

  test("404 when no build is deployed", async () => {
    getLatest.mockResolvedValue(null);
    const res = await manifestRoute();
    expect(res.status).toBe(404);
    expect(presignedGet).not.toHaveBeenCalled();
  });

  test("503 when Blob is not configured (no presigned URL)", async () => {
    getLatest.mockResolvedValue(LATEST);
    presignedGet.mockResolvedValue(null);
    const res = await manifestRoute();
    expect(res.status).toBe(503);
  });
});
