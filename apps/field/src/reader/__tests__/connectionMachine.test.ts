import { describe, expect, test } from "vitest";

import {
  isStale,
  reduceConnection,
  shouldProbe,
  shouldRunHeartbeat,
} from "@/reader/connectionMachine";

describe("reduceConnection", () => {
  test("connected rises from disconnected and reports the change", () => {
    const r = reduceConnection(false, { type: "connected" });
    expect(r.connected).toBe(true);
    expect(r.changed).toBe(true);
  });

  test("connected is a no-op when already connected", () => {
    const r = reduceConnection(true, { type: "connected" });
    expect(r.connected).toBe(true);
    expect(r.changed).toBe(false);
  });

  test("disconnected drops from connected and reports the change", () => {
    const r = reduceConnection(true, { type: "disconnected" });
    expect(r.connected).toBe(false);
    expect(r.changed).toBe(true);
  });

  test("disconnected is a no-op when already disconnected", () => {
    const r = reduceConnection(false, { type: "disconnected" });
    expect(r.connected).toBe(false);
    expect(r.changed).toBe(false);
  });

  test("stale behaves like disconnected (heartbeat liveness failure)", () => {
    expect(reduceConnection(true, { type: "stale" })).toEqual({
      connected: false,
      changed: true,
    });
    expect(reduceConnection(false, { type: "stale" })).toEqual({
      connected: false,
      changed: false,
    });
  });
});

describe("shouldRunHeartbeat", () => {
  test("runs only for native + connected + foreground", () => {
    expect(shouldRunHeartbeat(true, true, true)).toBe(true);
    expect(shouldRunHeartbeat(false, true, true)).toBe(false); // simulated transport
    expect(shouldRunHeartbeat(true, false, true)).toBe(false); // not connected
    expect(shouldRunHeartbeat(true, true, false)).toBe(false); // backgrounded
  });
});

describe("shouldProbe", () => {
  test("probes only when idle and the interval has elapsed", () => {
    expect(shouldProbe("idle", 8_000, 8_000)).toBe(true);
    expect(shouldProbe("idle", 10_000, 8_000)).toBe(true);
    expect(shouldProbe("idle", 7_999, 8_000)).toBe(false);
  });

  test("never probes during active modes (they stream data already)", () => {
    expect(shouldProbe("checkin", 10_000, 8_000)).toBe(false);
    expect(shouldProbe("inventory", 10_000, 8_000)).toBe(false);
    expect(shouldProbe("finder", 10_000, 8_000)).toBe(false);
  });
});

describe("isStale", () => {
  test("true once the silence exceeds the timeout", () => {
    expect(isStale(20_000, 20_000)).toBe(true);
    expect(isStale(25_000, 20_000)).toBe(true);
    expect(isStale(19_999, 20_000)).toBe(false);
  });
});
