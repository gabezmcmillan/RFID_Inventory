import { describe, expect, test } from "vitest";

import { formatEpcByte, isEpcByteExhausted, MAX_EPC_BYTE } from "@/lib/epcByte";

describe("EPC device-byte allocation", () => {
  test("formats a counter as a 2-digit uppercase hex byte", () => {
    expect(formatEpcByte(0)).toBe("00");
    expect(formatEpcByte(10)).toBe("0A");
    expect(formatEpcByte(255)).toBe("FF");
  });

  test("rejects out-of-range values", () => {
    expect(() => formatEpcByte(-1)).toThrow(RangeError);
    expect(() => formatEpcByte(256)).toThrow(RangeError);
    expect(() => formatEpcByte(1.5)).toThrow(RangeError);
  });

  test("exhaustion is reached once all 256 bytes (00..FF) are assigned", () => {
    // allocateNextEpcByte returns null when the next counter exceeds 0xFF.
    // isEpcByteExhausted(next) mirrors that: true once next > 0xFF.
    expect(isEpcByteExhausted(255)).toBe(false); // 0xFF still assignable
    expect(isEpcByteExhausted(256)).toBe(true); // 256th+ call is exhausted
    expect(MAX_EPC_BYTE).toBe(0xff);
  });
});
