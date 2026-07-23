/**
 * RN-safe global text-ID helper — the single source of collision-free primary
 * keys for field-created rows (plan 010, Phase 2).
 *
 * Field replicas mint rows offline and reconcile via Turso Sync, so an
 * autoincrement integer keyed to one replica's local sequence would collide
 * the moment a second replica inserts. A 128-bit UUIDv4 string (lowercase,
 * hyphenated) is globally unique with negligible collision probability and
 * sorts/stores cheaply as SQLite `TEXT`.
 *
 * "RN-safe" means the helper runs unchanged on-device (Hermes), in Node, and in
 * tests with **no Node-only import** (no `node:crypto`, no native addon). It
 * prefers the Web Crypto `crypto.getRandomValues` global when present (Node 18+
 * exposes it; React Native gets it from the `react-native-get-random-values`
 * polyfill if the app imports it) and falls back to a `Math.random`-seeded byte
 * generator otherwise. The fallback still yields a full 122 bits of UUIDv4
 * entropy — collision-safe at this scale (thousands of rows) though not
 * cryptographically unpredictable. IDs are not secrets, so predictability is
 * not a security concern; collision-safety is the only requirement.
 *
 * Recommended hardening (operator checklist): import `react-native-get-random-values`
 * once at the field app root so `crypto.getRandomValues` is polyfilled on-device,
 * moving the RNG from `Math.random` to the platform CSPRNG.
 */

/** Fill `n` bytes with uniform random, using the strongest available source. */
function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  const g = globalThis as { crypto?: { getRandomValues?: (arr: Uint8Array) => Uint8Array } };
  const getRandomValues = g.crypto?.getRandomValues;
  if (typeof getRandomValues === "function") {
    return getRandomValues.call(g.crypto, buf);
  }
  // Fallback (Hermes without the getRandomValues polyfill): Math.random.
  for (let i = 0; i < n; i++) {
    buf[i] = (Math.random() * 0x100) | 0;
  }
  return buf;
}

const HEX = "0123456789abcdef";

/**
 * Mint a fresh lowercase-hyphenated UUIDv4 string (e.g.
 * `f47ac10b-58cc-4372-a567-0e02b2c3d479`). Collision-free across replicas and
 * restarts; never returns the same value twice in practice.
 */
export function newId(): string {
  const b = randomBytes(16);
  // UUIDv4: set version (4) and variant (10xx) bits on the two fixed bytes.
  const v6 = (b[6] ?? 0) & 0x0f;
  const v8 = (b[8] ?? 0) & 0x3f;
  const out: string[] = [];
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out.push("-");
    let byte = b[i] ?? 0;
    if (i === 6) byte = v6 | 0x40;
    if (i === 8) byte = v8 | 0x80;
    out.push(HEX.charAt(byte >> 4), HEX.charAt(byte & 0x0f));
  }
  return out.join("");
}
