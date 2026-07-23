import { describe, expect, test } from "vitest";

import { isAllowed, parseAllowlist } from "@/lib/allowlist";

describe("field-operator allowlist", () => {
  test("parses comma- and whitespace-separated emails, lowercased", () => {
    const set = parseAllowlist("Alice@Acme.com, bob@acme.com  carol@acme.com");
    expect(set).toEqual(new Set(["alice@acme.com", "bob@acme.com", "carol@acme.com"]));
  });

  test("empty / absent allowlist denies everyone", () => {
    expect(isAllowed("anyone@acme.com", "")).toBe(false);
    expect(isAllowed("anyone@acme.com", undefined)).toBe(false);
    expect(isAllowed("anyone@acme.com", "   ")).toBe(false);
  });

  test("allowlist denial: an email not on the list is rejected", () => {
    expect(isAllowed("eve@evil.com", "alice@acme.com, bob@acme.com")).toBe(false);
  });

  test("matching is case-insensitive and trims whitespace", () => {
    expect(isAllowed("  Alice@Acme.COM  ", "alice@acme.com")).toBe(true);
  });

  test("non-email tokens are ignored", () => {
    expect(isAllowed("alice@acme.com", "not-an-email, alice@acme.com")).toBe(true);
  });
});
