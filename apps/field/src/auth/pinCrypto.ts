/**
 * Device PIN cryptography (plan 010, operator scope addition).
 *
 * Pure (no React Native, no I/O): a salted, iterated key-derivation + a
 * constant-time compare, plus the small wrong-entry backoff policy. Kept pure
 * so it is fully unit-testable under node (the field vitest suite runs in the
 * node environment with no device).
 *
 * Threat model: the PIN guards a *linked* field device that may be used
 * offline (the warehouse can lose Wi-Fi), so verification is fully local. Only
 * a salted hash is ever stored (see `pinStore.ts`); the plaintext PIN never
 * leaves the entry field. A 4–8 digit PIN is a low-entropy secret, so the
 * derived key uses PBKDF2-HMAC-SHA256 with a per-install random salt and a
 * deliberately large iteration count to make an offline brute force of a
 * stolen secure-store value expensive. The real backstop is that the hash
 * lives in the device Keychain (expo-secure-store), not application storage.
 */

import { sha256 } from "js-sha256";

/** Number of PBKDF2-HMAC-SHA256 iterations. High enough to slow a brute force
 *  of a 4-digit PIN (10⁴ entries) into seconds-per-attempt territory on a phone
 *  that has already exfiltrated the Keychain, while staying sub-100ms on-device
 *  for a single legitimate verify. Tunable; tests are independent of it. */
export const PIN_ITERATIONS = 50_000;

/** Salt length in bytes (16 bytes / 128 bits of entropy per install). */
export const PIN_SALT_BYTES = 16;

/** Derived-key length in bytes (32 bytes / 256 bits). */
export const PIN_KEY_BYTES = 32;

/** A stored PIN record: the algorithm tag, salt, and derived key (all base64). */
export interface PinHash {
  /** Algorithm version tag, so the scheme can evolve without a migration. */
  v: 1;
  /** base64 of the per-install random salt. */
  s: string;
  /** base64 of PBKDF2-HMAC-SHA256(salt, pin, PIN_ITERATIONS). */
  k: string;
  /** Iteration count captured at hash time (verifies use the stored value). */
  n: number;
}

// ---- base64 helpers (Uint8Array <-> base64) --------------------------------

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Cryptographically-strong random bytes. Falls back to Math.random only when
 *  `crypto.getRandomValues` is unavailable (older test runtimes); production
 *  always has it via React Native's polyfill. */
function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) {
    // Call as a method so `this` stays bound to the Crypto object (destructuring
    // the function loses the binding and throws "Value of this must be Crypto").
    crypto.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

// ---- PBKDF2-HMAC-SHA256 ----------------------------------------------------

/** One HMAC-SHA256 step returning a fresh Uint8Array (32 bytes). */
function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array<ArrayBuffer> {
  const ab = sha256.hmac.arrayBuffer(key, msg);
  return new Uint8Array(ab);
}

/** XOR two equal-length byte arrays into a new array. */
function xor(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/**
 * PBKDF2-HMAC-SHA256 (RFC 8018) over a single block (dkLen <= 32). Sufficient
 * for {@link PIN_KEY_BYTES}. Deterministic and standard, so a future server or
 * migration tool can re-derive identically.
 */
export function pbkdf2HmacSha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  dkLen: number,
): Uint8Array<ArrayBuffer> {
  if (dkLen > 32) throw new Error("pbkdf2: dkLen > 32 not supported");
  const blockIndex = 1;
  const intBytes = new Uint8Array(4);
  intBytes[3] = blockIndex; // big-endian 1
  const u1 = hmacSha256(password, concat(salt, intBytes));
  // Copy into a fresh ArrayBuffer-backed array so `t` stays Uint8Array<ArrayBuffer>
  // (u1.slice() widens to ArrayBufferLike, which the xor/concat helpers reject).
  let t = new Uint8Array(u1);
  let u = u1;
  for (let i = 1; i < iterations; i++) {
    u = hmacSha256(password, u);
    t = xor(t, u);
  }
  // Copy into a fresh ArrayBuffer-backed array so the return type is
  // Uint8Array<ArrayBuffer> (t.slice() widens to ArrayBufferLike under strict libs).
  const out = new Uint8Array(dkLen);
  out.set(t.subarray(0, dkLen));
  return out;
}

/** Concatenate two byte arrays into a new one. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---- public API ------------------------------------------------------------

/** Derive a {@link PinHash} from a plaintext PIN and a fresh random salt. */
export function hashPin(pin: string): PinHash {
  const salt = randomBytes(PIN_SALT_BYTES);
  const key = pbkdf2HmacSha256(utf8(pin), salt, PIN_ITERATIONS, PIN_KEY_BYTES);
  return { v: 1, s: bytesToB64(salt), k: bytesToB64(key), n: PIN_ITERATIONS };
}

/** UTF-8 encode a string into a new Uint8Array. */
function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s);
}

/**
 * Constant-time compare of a candidate PIN against a stored {@link PinHash}.
 * Returns `true` on a match. Never throws on a malformed record — a corrupt
 * store simply fails closed (treated as a mismatch), so the user re-sets the PIN
 * via the recovery flow rather than bypassing the gate.
 */
export function verifyPin(pin: string, stored: PinHash | null): boolean {
  if (!stored || stored.v !== 1 || typeof stored.s !== "string" || typeof stored.k !== "string") {
    return false;
  }
  const iterations = typeof stored.n === "number" && stored.n > 0 ? stored.n : PIN_ITERATIONS;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = b64ToBytes(stored.s);
    expected = b64ToBytes(stored.k);
  } catch {
    return false;
  }
  if (expected.length !== PIN_KEY_BYTES) return false;
  const candidate = pbkdf2HmacSha256(utf8(pin), salt, iterations, PIN_KEY_BYTES);
  return constantTimeEqual(candidate, expected);
}

/** Constant-time equality of two equal-length byte arrays. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---- wrong-entry backoff ---------------------------------------------------

/**
 * The lockout duration (ms) imposed before the {@code attempts+1}th wrong entry
 * is accepted. Small, escalating, capped — the goal is to make rapid guessing
 * annoying, not to lock a forgetful operator out for a shift.
 *
 *   attempts 0..2  -> 0ms        (three free tries)
 *   attempts 3     -> 1,000ms
 *   attempts 4     -> 2,000ms
 *   attempts 5     -> 5,000ms
 *   attempts 6+    -> 10,000ms   (cap)
 */
export function nextLockoutMs(attempts: number): number {
  if (attempts < 3) return 0;
  if (attempts === 3) return 1_000;
  if (attempts === 4) return 2_000;
  if (attempts === 5) return 5_000;
  return 10_000;
}

/** Minimum acceptable PIN length (digits). The UI enforces this on set. */
export const MIN_PIN_LEN = 4;
/** Maximum acceptable PIN length (digits). */
export const MAX_PIN_LEN = 8;

/** True when `pin` is all digits and within the length bounds. */
export function isValidPin(pin: string): boolean {
  if (pin.length < MIN_PIN_LEN || pin.length > MAX_PIN_LEN) return false;
  return /^[0-9]+$/.test(pin);
}
