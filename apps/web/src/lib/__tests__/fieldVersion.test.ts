import { describe, expect, test } from "vitest";

import { buildInstallManifestPlist, parseBuildNumber } from "@/lib/fieldVersion";

describe("fieldVersion", () => {
  test("parseBuildNumber parses positive ints and rejects the rest", () => {
    expect(parseBuildNumber("42")).toBe(42);
    expect(parseBuildNumber(7)).toBe(7);
    expect(parseBuildNumber("0")).toBeNull();
    expect(parseBuildNumber("-1")).toBeNull();
    expect(parseBuildNumber("abc")).toBeNull();
    expect(parseBuildNumber(null)).toBeNull();
    expect(parseBuildNumber(undefined)).toBeNull();
  });

  test("buildInstallManifestPlist emits a valid software-package plist", () => {
    const plist = buildInstallManifestPlist({
      ipaUrl: "https://store.private.blob.vercel-storage.com/field-ios/1.0.0/42.ipa?sig=abc&b=2",
      bundleId: "com.brasfieldgorrie.rfid-field",
      bundleVersion: "1.0.0",
      title: "RFID Field",
    });
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain("<string>software-package</string>");
    expect(plist).toContain(
      "<string>https://store.private.blob.vercel-storage.com/field-ios/1.0.0/42.ipa?sig=abc&amp;b=2</string>",
    );
    expect(plist).toContain("<string>com.brasfieldgorrie.rfid-field</string>");
    expect(plist).toContain("<string>1.0.0</string>");
    expect(plist).toContain("<string>RFID Field</string>");
    expect(plist).toContain("<string>software</string>");
  });

  test("buildInstallManifestPlist escapes XML special characters in the title", () => {
    const plist = buildInstallManifestPlist({
      ipaUrl: "https://x/ipa",
      bundleId: "com.brasfieldgorrie.rfid-field",
      bundleVersion: "1.0.0",
      title: "RFID <Field> & \"Co\"",
    });
    expect(plist).toContain("RFID &lt;Field&gt; &amp; &quot;Co&quot;");
    expect(plist).not.toContain("<Field>");
  });
});
