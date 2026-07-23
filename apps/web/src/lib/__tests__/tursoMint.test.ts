import { describe, expect, test } from "vitest";

import { buildMintRequest } from "@/lib/tursoMint";

describe("Turso mint request building (no network)", () => {
  test("builds the Platform API request with bearer + expiration + permissions", () => {
    const { url, init } = buildMintRequest({
      platformToken: "plat-tok",
      org: "vercel",
      database: "rfid-warehouse",
      expirationSec: 300,
      permissions: { read_only: true },
    });
    expect(url).toBe(
      "https://api.turso.tech/v1/organizations/vercel/databases/rfid-warehouse/auth/tokens?expiration=300",
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer plat-tok",
      "Content-Type": "application/json",
    });
    expect(init.body).toBe(JSON.stringify({ read_only: true }));
  });

  test("omits the body when no fine-grained permissions are requested", () => {
    const { init } = buildMintRequest({
      platformToken: "plat-tok",
      org: "vercel",
      database: "rfid-warehouse",
      expirationSec: 60,
    });
    expect(init.body).toBeUndefined();
  });
});
