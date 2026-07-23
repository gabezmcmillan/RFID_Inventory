import { describe, expect, test } from "vitest";

import { DEFAULT_RELOCK_AFTER_MS, initialLockState, reduceLock, type LockState } from "@/auth/lockState";

function armed(over: Partial<LockState> = {}): LockState {
  return { ...initialLockState, hasPin: true, ...over };
}

describe("lockState — launch", () => {
  test("launch with a PIN locks; without a PIN it stays unlocked", () => {
    expect(reduceLock(initialLockState, { type: "launch", hasPin: true }).locked).toBe(true);
    expect(reduceLock(initialLockState, { type: "launch", hasPin: false }).locked).toBe(false);
  });
});

describe("lockState — set / clear PIN", () => {
  test("pinSet arms the gate but does not lock the just-authenticated user", () => {
    const s = reduceLock(initialLockState, { type: "pinSet" });
    expect(s.hasPin).toBe(true);
    expect(s.locked).toBe(false);
  });

  test("pinCleared disarms the gate and unlocks", () => {
    const s = reduceLock(armed({ locked: true }), { type: "pinCleared" });
    expect(s.hasPin).toBe(false);
    expect(s.locked).toBe(false);
  });
});

describe("lockState — background / foreground relock", () => {
  test("a quick app switch under the threshold does not relock", () => {
    let s = armed({ locked: false });
    s = reduceLock(s, { type: "background", at: 1_000 });
    s = reduceLock(s, { type: "foreground", at: 1_000 + 5_000, relockAfterMs: DEFAULT_RELOCK_AFTER_MS });
    expect(s.locked).toBe(false);
  });

  test("a long absence past the threshold relocks", () => {
    let s = armed({ locked: false });
    s = reduceLock(s, { type: "background", at: 1_000 });
    s = reduceLock(s, { type: "foreground", at: 1_000 + DEFAULT_RELOCK_AFTER_MS + 1, relockAfterMs: DEFAULT_RELOCK_AFTER_MS });
    expect(s.locked).toBe(true);
  });

  test("a locked app stays locked on foreground (no escape by backgrounding)", () => {
    let s = armed({ locked: true });
    s = reduceLock(s, { type: "background", at: 5_000 });
    s = reduceLock(s, { type: "foreground", at: 999_999, relockAfterMs: 0 });
    expect(s.locked).toBe(true);
  });

  test("without a PIN, foreground never locks", () => {
    let s = reduceLock(initialLockState, { type: "launch", hasPin: false });
    s = reduceLock(s, { type: "background", at: 1_000 });
    s = reduceLock(s, { type: "foreground", at: 1_000 + 10 * DEFAULT_RELOCK_AFTER_MS, relockAfterMs: 0 });
    expect(s.locked).toBe(false);
  });

  test("foreground with no prior background does not relock (launch already decided)", () => {
    const s = armed({ locked: false, lastBackgroundedAt: null });
    const next = reduceLock(s, { type: "foreground", at: 99, relockAfterMs: 0 });
    expect(next.locked).toBe(false);
  });

  test("a zero threshold relocks on any return to the foreground", () => {
    let s = armed({ locked: false });
    s = reduceLock(s, { type: "background", at: 1_000 });
    s = reduceLock(s, { type: "foreground", at: 1_001, relockAfterMs: 0 });
    expect(s.locked).toBe(true);
  });
});

describe("lockState — unlock", () => {
  test("unlocked clears the lock but keeps the gate armed", () => {
    const s = reduceLock(armed({ locked: true }), { type: "unlocked" });
    expect(s.locked).toBe(false);
    expect(s.hasPin).toBe(true);
  });
});
