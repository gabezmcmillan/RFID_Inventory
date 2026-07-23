/**
 * Device PIN store (plan 010, operator scope addition).
 *
 * The persistence layer over {@link pinCrypto}: a salted {@link PinHash} per
 * named slot lives in `expo-secure-store` (the iOS Keychain) — never the
 * plaintext PIN. Two slots share one mechanism so there is a single PIN design
 * instead of two half-baked ones:
 *
 *   - `"device"`: the required app-unlock gate. Set during/immediately after
 *     linking; the app is locked until it is entered on launch and on
 *     return-to-foreground after a timeout.
 *   - `"admin"`: the admin-surface gate (plan 006/007). Replaces the legacy
 *     plaintext AsyncStorage admin PIN (`rfid.field.adminPin`, default "1234")
 *     — see {@link migrateLegacyAdminPin}.
 *
 * Wrong-entry backoff (attempts + lockout-until) is persisted per slot so a
 * restart does not reset an active lockout. The deps are injected so unit
 * tests use in-memory fakes instead of the real RN modules.
 */

import { isValidPin, hashPin, nextLockoutMs, verifyPin, type PinHash } from "./pinCrypto";

/** Named PIN slots — one mechanism, two purposes. */
export type PinSlot = "device" | "admin";

/** Minimal expo-secure-store surface the PIN store needs. */
export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** Minimal AsyncStorage surface for the legacy admin-PIN migration. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
}

/** Persisted wrong-entry backoff state for one slot. */
interface PinState {
  /** Consecutive wrong attempts since the last correct entry. */
  attempts: number;
  /** Epoch ms before which another attempt is rejected. */
  lockoutUntil: number;
}

/** Result of a verify attempt. */
export interface PinVerifyResult {
  ok: boolean;
  /** Consecutive wrong attempts after this attempt (0 on success). */
  attempts: number;
  /** Epoch ms until which the next attempt is blocked (0 when not locked). */
  lockoutUntil: number;
}

/** Legacy AsyncStorage key/value for the old plaintext admin PIN. */
export const LEGACY_ADMIN_PIN_KEY = "rfid.field.adminPin";
export const LEGACY_ADMIN_PIN_DEFAULT = "1234";

function hashKey(slot: PinSlot): string {
  return `rfid.pin.${slot}.hash`;
}

function stateKey(slot: PinSlot): string {
  return `rfid.pin.${slot}.state`;
}

/**
 * The PIN store. Constructed once for the app with the real
 * `expo-secure-store` + `AsyncStorage`; tests inject in-memory fakes.
 */
export class PinStore {
  constructor(
    private readonly _secure: SecureStoreLike,
    private readonly _asyncStorage: AsyncStorageLike | null,
    private readonly _now: () => number = Date.now,
  ) {}

  /** True when a PIN hash is stored for the slot. */
  async hasPin(slot: PinSlot): Promise<boolean> {
    return (await this._secure.getItemAsync(hashKey(slot))) !== null;
  }

  /**
   * Set (or replace) the PIN for a slot. Validates the PIN and clears any
   * backoff state. Throws a user-facing message on an invalid PIN.
   */
  async setPin(slot: PinSlot, pin: string): Promise<void> {
    if (!isValidPin(pin)) {
      throw new Error(`PIN must be ${4}-${8} digits.`);
    }
    const hash = hashPin(pin);
    await this._secure.setItemAsync(hashKey(slot), JSON.stringify(hash));
    await this._setState(slot, { attempts: 0, lockoutUntil: 0 });
  }

  /** Clear the PIN hash and backoff state for a slot (used on unlink). */
  async clearPin(slot: PinSlot): Promise<void> {
    await this._secure.deleteItemAsync(hashKey(slot)).catch(() => {});
    await this._secure.deleteItemAsync(stateKey(slot)).catch(() => {});
  }

  /**
   * Verify a candidate PIN against the stored hash, enforcing the persisted
   * backoff. On success the backoff state is reset; on failure the attempt count
   * rises and a fresh lockout-until is recorded. A call while locked out is
   * rejected as `ok:false` without incrementing attempts.
   */
  async verify(slot: PinSlot, candidate: string): Promise<PinVerifyResult> {
    const state = await this._getState(slot);
    const now = this._now();
    if (now < state.lockoutUntil) {
      return { ok: false, attempts: state.attempts, lockoutUntil: state.lockoutUntil };
    }
    const stored = await this._loadHash(slot);
    if (verifyPin(candidate, stored)) {
      await this._setState(slot, { attempts: 0, lockoutUntil: 0 });
      return { ok: true, attempts: 0, lockoutUntil: 0 };
    }
    const attempts = state.attempts + 1;
    const delay = nextLockoutMs(state.attempts);
    const lockoutUntil = delay > 0 ? now + delay : 0;
    await this._setState(slot, { attempts, lockoutUntil });
    return { ok: false, attempts, lockoutUntil };
  }

  /** Read the current backoff state for a slot (for UI display). */
  async getBackoff(slot: PinSlot): Promise<PinVerifyResult> {
    const state = await this._getState(slot);
    return { ok: false, attempts: state.attempts, lockoutUntil: state.lockoutUntil };
  }

  /**
   * One-time migration of the legacy plaintext admin PIN (plan 006) into the
   * hashed `"admin"` slot. If an `"admin"` hash already exists, this is a no-op
   * (the user has set a real PIN since). Otherwise, if AsyncStorage holds a
   * legacy admin PIN (or the default), it is hashed into the admin slot and the
   * legacy entry is removed. Safe to call on every app start; idempotent.
   *
   * Returns the migrated PIN value (so the caller can log "migrated") or null.
   */
  async migrateLegacyAdminPin(): Promise<string | null> {
    if (await this.hasPin("admin")) return null;
    if (!this._asyncStorage) return null;
    let legacy: string | null = null;
    try {
      legacy = await this._asyncStorage.getItem(LEGACY_ADMIN_PIN_KEY);
    } catch {
      return null;
    }
    if (legacy === null) {
      // Never set explicitly — seed the documented default so existing admin
      // access keeps working until the operator changes it.
      legacy = LEGACY_ADMIN_PIN_DEFAULT;
    }
    if (!isValidPin(legacy)) return null;
    const hash = hashPin(legacy);
    await this._secure.setItemAsync(hashKey("admin"), JSON.stringify(hash));
    await this._setState("admin", { attempts: 0, lockoutUntil: 0 });
    try {
      await this._asyncStorage.removeItem(LEGACY_ADMIN_PIN_KEY);
    } catch {
      // Best-effort; the hashed slot is the source of truth now.
    }
    return legacy;
  }

  // ---- internals -----------------------------------------------------------

  private async _loadHash(slot: PinSlot): Promise<PinHash | null> {
    const raw = await this._secure.getItemAsync(hashKey(slot));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PinHash;
    } catch {
      return null;
    }
  }

  private async _getState(slot: PinSlot): Promise<PinState> {
    const raw = await this._secure.getItemAsync(stateKey(slot));
    if (!raw) return { attempts: 0, lockoutUntil: 0 };
    try {
      const parsed = JSON.parse(raw) as Partial<PinState>;
      return {
        attempts: typeof parsed.attempts === "number" ? parsed.attempts : 0,
        lockoutUntil: typeof parsed.lockoutUntil === "number" ? parsed.lockoutUntil : 0,
      };
    } catch {
      return { attempts: 0, lockoutUntil: 0 };
    }
  }

  private async _setState(slot: PinSlot, state: PinState): Promise<void> {
    await this._secure.setItemAsync(stateKey(slot), JSON.stringify(state));
  }
}
