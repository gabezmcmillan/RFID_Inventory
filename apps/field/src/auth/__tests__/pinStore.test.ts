import { describe, expect, test } from "vitest";

import { PinStore, type AsyncStorageLike, type SecureStoreLike } from "@/auth/pinStore";
import { LEGACY_ADMIN_PIN_DEFAULT, LEGACY_ADMIN_PIN_KEY } from "@/auth/pinStore";

/** In-memory secure-store fake. */
function memSecure(): SecureStoreLike {
  const map = new Map<string, string>();
  return {
    getItemAsync: async (k) => map.get(k) ?? null,
    setItemAsync: async (k, v) => {
      map.set(k, v);
    },
    deleteItemAsync: async (k) => {
      map.delete(k);
    },
  };
}

/** In-memory AsyncStorage fake with a pre-seeded legacy admin PIN. */
function memAsync(legacy: string | null): AsyncStorageLike & { _map: Map<string, string> } {
  const map = new Map<string, string>();
  if (legacy !== null) map.set(LEGACY_ADMIN_PIN_KEY, legacy);
  return {
    _map: map,
    getItem: async (k) => map.get(k) ?? null,
    removeItem: async (k) => {
      map.delete(k);
    },
  };
}

describe("PinStore — set / verify / clear", () => {
  test("a set PIN verifies and a wrong one does not", async () => {
    const store = new PinStore(memSecure(), null);
    await store.setPin("device", "1234");
    expect(await store.hasPin("device")).toBe(true);
    expect((await store.verify("device", "1234")).ok).toBe(true);
    expect((await store.verify("device", "0000")).ok).toBe(false);
  });

  test("setPin rejects an invalid PIN", async () => {
    const store = new PinStore(memSecure(), null);
    await expect(store.setPin("device", "12")).rejects.toThrow();
    await expect(store.setPin("device", "abcd")).rejects.toThrow();
    expect(await store.hasPin("device")).toBe(false);
  });

  test("clearPin removes the hash and backoff state", async () => {
    const store = new PinStore(memSecure(), null);
    await store.setPin("admin", "2468");
    await store.verify("admin", "wrong");
    await store.clearPin("admin");
    expect(await store.hasPin("admin")).toBe(false);
    const back = await store.getBackoff("admin");
    expect(back.attempts).toBe(0);
  });

  test("slots are independent", async () => {
    const store = new PinStore(memSecure(), null);
    await store.setPin("device", "1111");
    await store.setPin("admin", "2222");
    expect((await store.verify("device", "1111")).ok).toBe(true);
    expect((await store.verify("device", "2222")).ok).toBe(false);
    expect((await store.verify("admin", "2222")).ok).toBe(true);
  });
});

describe("PinStore — wrong-entry backoff", () => {
  test("attempts increment and reset on a correct entry", async () => {
    const store = new PinStore(memSecure(), null);
    await store.setPin("device", "1234");
    expect((await store.verify("device", "x")).attempts).toBe(1);
    expect((await store.verify("device", "x")).attempts).toBe(2);
    const ok = await store.verify("device", "1234");
    expect(ok.ok).toBe(true);
    expect(ok.attempts).toBe(0);
  });

  test("a lockout blocks further attempts without incrementing", async () => {
    let now = 1_000;
    const store = new PinStore(memSecure(), null, () => now);
    await store.setPin("device", "1234");
    // Three free wrong entries (attempts 1..3), then the 4th triggers a lockout.
    for (let i = 1; i <= 3; i++) {
      const r = await store.verify("device", "wrong");
      expect(r.attempts).toBe(i);
      expect(r.lockoutUntil).toBe(0);
    }
    const r4 = await store.verify("device", "wrong");
    expect(r4.attempts).toBe(4);
    expect(r4.lockoutUntil).toBe(now + 1_000); // nextLockoutMs(3) = 1000
    // An attempt during the lockout window is rejected and does not increment.
    now += 500;
    const blocked = await store.verify("device", "1234"); // even the right PIN
    expect(blocked.ok).toBe(false);
    expect(blocked.attempts).toBe(4);
    expect(blocked.lockoutUntil).toBe(1_000 + 1_000);
    // After the window passes, the correct PIN unlocks and resets.
    now = 3_000;
    const ok = await store.verify("device", "1234");
    expect(ok.ok).toBe(true);
    expect(ok.attempts).toBe(0);
  });

  test("backoff state persists across a new PinStore instance (restart)", async () => {
    const secure = memSecure();
    let now = 5_000;
    const a = new PinStore(secure, null, () => now);
    await a.setPin("device", "1234");
    for (let i = 0; i < 4; i++) await a.verify("device", "wrong");
    // Reconstruct from the same backing store (simulates an app restart).
    const b = new PinStore(secure, null, () => now);
    const back = await b.getBackoff("device");
    expect(back.attempts).toBe(4);
    expect(back.lockoutUntil).toBe(now + 1_000);
    // Still locked immediately after "restart".
    expect((await b.verify("device", "1234")).ok).toBe(false);
    now += 2_000;
    expect((await b.verify("device", "1234")).ok).toBe(true);
  });
});

describe("PinStore — legacy admin PIN migration", () => {
  test("migrates a stored legacy admin PIN into the hashed admin slot and removes it", async () => {
    const async = memAsync("4567");
    const store = new PinStore(memSecure(), async);
    const migrated = await store.migrateLegacyAdminPin();
    expect(migrated).toBe("4567");
    expect(await store.hasPin("admin")).toBe(true);
    expect((await store.verify("admin", "4567")).ok).toBe(true);
    expect(async._map.has(LEGACY_ADMIN_PIN_KEY)).toBe(false);
  });

  test("seeds the documented default when no legacy PIN was ever set", async () => {
    const async = memAsync(null);
    const store = new PinStore(memSecure(), async);
    const migrated = await store.migrateLegacyAdminPin();
    expect(migrated).toBe(LEGACY_ADMIN_PIN_DEFAULT);
    expect((await store.verify("admin", LEGACY_ADMIN_PIN_DEFAULT)).ok).toBe(true);
  });

  test("is a no-op when an admin PIN is already set (operator changed it)", async () => {
    const async = memAsync("4567");
    const store = new PinStore(memSecure(), async);
    await store.setPin("admin", "9999");
    const migrated = await store.migrateLegacyAdminPin();
    expect(migrated).toBe(null);
    // The operator's PIN wins; the legacy value is NOT re-seeded.
    expect((await store.verify("admin", "9999")).ok).toBe(true);
    expect((await store.verify("admin", "4567")).ok).toBe(false);
  });

  test("skips a malformed legacy value without seeding", async () => {
    const async = memAsync("abc"); // not digits
    const store = new PinStore(memSecure(), async);
    const migrated = await store.migrateLegacyAdminPin();
    expect(migrated).toBe(null);
    expect(await store.hasPin("admin")).toBe(false);
  });

  test("is a no-op when there is no AsyncStorage (no legacy to migrate)", async () => {
    const store = new PinStore(memSecure(), null);
    const migrated = await store.migrateLegacyAdminPin();
    expect(migrated).toBe(null);
    expect(await store.hasPin("admin")).toBe(false);
  });
});
