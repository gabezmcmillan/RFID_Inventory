/**
 * Phase 2 — atomic EPC serial reservation: the per-device serial counter only
 * moves forward, so a crash after reservation wastes serials but never reuses
 * them. Proved against the in-memory allocator (the on-device implementation
 * shares the same contract via an atomic `UPDATE … SET value = value + n`).
 */

import { describe, expect, test } from "vitest";

import { allocateEpcs, makeInMemoryEpcAllocator } from "../index";
import { openTestDb } from "../testing/openTestDb";

const epcSerial = (epc: string): string => epc.slice(10, 24);

describe("atomic EPC serial reservation (Phase 2)", () => {
  test("reserveSerials advances monotonically and never reuses", async () => {
    const a = makeInMemoryEpcAllocator("01", 0);
    expect(await a.reserveSerials(3)).toBe(1); // range [1,3]
    expect(await a.reserveSerials(2)).toBe(4); // range [4,5]
    expect(await a.reserveSerials(1)).toBe(6); // range [6]
  });

  test("a crash after reservation wastes serials but never reuses them", async () => {
    const a = makeInMemoryEpcAllocator("01", 0);
    // Reserve 3 (range [1,3]) then "crash" before printing — those serials are wasted.
    const wastedStart = await a.reserveSerials(3);
    expect(wastedStart).toBe(1);
    // Next reservation continues past the wasted range, never reusing 1-3.
    const next = await a.reserveSerials(3);
    expect(next).toBe(4); // range [4,6]
  });

  test("allocateEpcs never reuses a serial across calls even after a mid-flight crash", async () => {
    const db = await openTestDb();
    const a = makeInMemoryEpcAllocator("01", 0);
    const first = await allocateEpcs(db, 3, a);
    expect(first).toHaveLength(3);
    const used = new Set(first.map(epcSerial));

    // Simulate a crash: reserve 2 serials that never become labels (wasted).
    await a.reserveSerials(2);

    const second = await allocateEpcs(db, 3, a);
    expect(second).toHaveLength(3);
    for (const s of second.map(epcSerial)) {
      expect(used.has(s)).toBe(false); // never reused
      used.add(s);
    }
    // The wasted serials (4,5) are absent from both batches.
    expect(used.has("00000000000004")).toBe(false);
    expect(used.has("00000000000005")).toBe(false);
  });

  test("two devices with the same serial counter never collide (device id differs)", async () => {
    const dbA = await openTestDb();
    const dbB = await openTestDb();
    const a = makeInMemoryEpcAllocator("01", 0);
    const b = makeInMemoryEpcAllocator("02", 0);
    const epcsA = await allocateEpcs(dbA, 2, a);
    const epcsB = await allocateEpcs(dbB, 2, b);
    // Same serials, different device bytes → distinct EPCs, no collision.
    expect(epcsA).not.toEqual(epcsB);
    expect(new Set([...epcsA, ...epcsB]).size).toBe(4);
    for (const epc of epcsA) expect(epc.slice(8, 10)).toBe("01");
    for (const epc of epcsB) expect(epc.slice(8, 10)).toBe("02");
  });
});
