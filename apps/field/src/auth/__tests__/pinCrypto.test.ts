import { pbkdf2Sync } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  hashPin,
  isValidPin,
  MAX_PIN_LEN,
  MIN_PIN_LEN,
  nextLockoutMs,
  PIN_ITERATIONS,
  PIN_KEY_BYTES,
  PIN_SALT_BYTES,
  pbkdf2HmacSha256,
  verifyPin,
} from "@/auth/pinCrypto";

describe("pinCrypto — PBKDF2", () => {
  test("pbkdf2HmacSha256 matches node crypto.pbkdf2Sync (HMAC-SHA256)", () => {
    const password = new TextEncoder().encode("1234");
    const salt = new TextEncoder().encode("0123456789abcdef");
    const dk = pbkdf2HmacSha256(password, salt, 1_000, 32);
    const ref = pbkdf2Sync(Buffer.from("1234"), Buffer.from("0123456789abcdef"), 1_000, 32, "sha256");
    expect(Array.from(dk)).toEqual(Array.from(ref));
  });

  test("pbkdf2HmacSha256 is deterministic for the same inputs", () => {
    const p = new TextEncoder().encode("secret");
    const s = new Uint8Array(16).map((_, i) => i);
    const a = pbkdf2HmacSha256(p, s, 50, 32);
    const b = pbkdf2HmacSha256(p, s, 50, 32);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  test("pbkdf2HmacSha256 rejects dkLen > 32", () => {
    expect(() => pbkdf2HmacSha256(new Uint8Array(), new Uint8Array(), 1, 33)).toThrow();
  });
});

describe("pinCrypto — hashPin / verifyPin", () => {
  test("a correct PIN verifies and a wrong PIN does not", () => {
    const hash = hashPin("1234");
    expect(verifyPin("1234", hash)).toBe(true);
    expect(verifyPin("1235", hash)).toBe(false);
  });

  test("two hashes of the same PIN use different salts (random salt)", () => {
    const a = hashPin("0000");
    const b = hashPin("0000");
    expect(a.s).not.toBe(b.s);
    expect(a.k).not.toBe(b.k);
    // ... but both verify the same PIN.
    expect(verifyPin("0000", a)).toBe(true);
    expect(verifyPin("0000", b)).toBe(true);
  });

  test("the stored iteration count is honored on verify", () => {
    const hash = hashPin("4321");
    expect(hash.n).toBe(PIN_ITERATIONS);
    expect(verifyPin("4321", hash)).toBe(true);
    // The derived key is bound to the iteration count: lowering it re-derives a
    // different key, so the stored hash no longer verifies (the stored n is the
    // single source of truth, not a hint a caller can override).
    const tampered = { ...hash, n: 10 };
    expect(verifyPin("4321", tampered)).toBe(false);
    expect(verifyPin("4322", hash)).toBe(false);
  });

  test("verifyPin fails closed on null / malformed records", () => {
    expect(verifyPin("1234", null)).toBe(false);
    expect(verifyPin("1234", { v: 2, s: "x", k: "y", n: 1 } as never)).toBe(false);
    expect(verifyPin("1234", { v: 1, s: "not-b64!", k: "y", n: 1 })).toBe(false);
    expect(verifyPin("1234", { v: 1, s: "AAAA", k: "BBBB", n: 1 })).toBe(false); // wrong key length
  });

  test("a hash has the expected shape", () => {
    const hash = hashPin("9999");
    expect(hash.v).toBe(1);
    // base64 of a 16-byte salt and 32-byte key (decode to check the raw length,
    // since base64 padding makes the char count a poor proxy).
    expect(atob(hash.s).length).toBe(PIN_SALT_BYTES);
    expect(atob(hash.k).length).toBe(PIN_KEY_BYTES);
  });
});

describe("pinCrypto — backoff policy", () => {
  test("first three wrong entries are free, then it escalates and caps", () => {
    expect(nextLockoutMs(0)).toBe(0);
    expect(nextLockoutMs(1)).toBe(0);
    expect(nextLockoutMs(2)).toBe(0);
    expect(nextLockoutMs(3)).toBe(1_000);
    expect(nextLockoutMs(4)).toBe(2_000);
    expect(nextLockoutMs(5)).toBe(5_000);
    expect(nextLockoutMs(6)).toBe(10_000);
    expect(nextLockoutMs(100)).toBe(10_000); // capped
  });
});

describe("pinCrypto — validation", () => {
  test("isValidPin accepts digit strings within the length bounds", () => {
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("12345678")).toBe(true);
  });

  test("isValidPin rejects too-short, too-long, and non-digit PINs", () => {
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("123456789")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
    expect(isValidPin("")).toBe(false);
    expect(isValidPin(" 234")).toBe(false);
  });

  test("the length constants are the documented bounds", () => {
    expect(MIN_PIN_LEN).toBe(4);
    expect(MAX_PIN_LEN).toBe(8);
  });
});
