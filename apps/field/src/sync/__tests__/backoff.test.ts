import { describe, expect, it } from "vitest";
import { baseBackoffMs, jitter, nextBackoffMs } from "../backoff";

describe("backoff", () => {
  it("doubles the base per attempt", () => {
    expect(baseBackoffMs(0)).toBe(1_000);
    expect(baseBackoffMs(1)).toBe(2_000);
    expect(baseBackoffMs(2)).toBe(4_000);
    expect(baseBackoffMs(3)).toBe(8_000);
  });

  it("caps at the max", () => {
    expect(baseBackoffMs(10)).toBe(30_000);
    expect(baseBackoffMs(100)).toBe(30_000);
  });

  it("applies ±25% jitter deterministically", () => {
    // rand 0.5 → multiplier exactly 1.0 (no jitter)
    expect(jitter(1_000, () => 0.5)).toBe(1_000);
    // rand 0.0 → 0.75
    expect(jitter(1_000, () => 0)).toBe(750);
    // rand 0.999... → ~1.25
    expect(jitter(1_000, () => 0.9999)).toBe(1_250);
  });

  it("nextBackoffMs composes base + jitter and caps", () => {
    const seq = Array.from({ length: 6 }, (_, i) =>
      nextBackoffMs(i, { rand: () => 0.5 }),
    );
    expect(seq).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
  });

  it("treats negative attempts as 0", () => {
    expect(baseBackoffMs(-3)).toBe(1_000);
  });
});
