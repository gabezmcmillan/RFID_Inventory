/**
 * EPC device-byte allocation (plan 010, Phase 2). Each linked field device is
 * assigned a permanent 2-hex byte (the `device id` embedded in every EPC it
 * mints: `prefix(8) + device(2) + serial(14)`). The byte is drawn from a
 * monotonic counter in the auth DB and is NEVER reused — even after a device
 * is unlinked or revoked, its byte stays retired so old printed labels can
 * never be confused with a new device's labels.
 */

/** Number of hex digits in a device byte. */
export const EPC_BYTE_LEN = 2;

/** Highest assignable byte value (256 distinct devices: 0x00..0xFF). */
export const MAX_EPC_BYTE = 0xff;

/**
 * Format a counter value as a 2-digit uppercase hex device byte. Values above
 * `MAX_EPC_BYTE` are out of range (the caller must refuse to link once the
 * counter is exhausted).
 */
export function formatEpcByte(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > MAX_EPC_BYTE) {
    throw new RangeError(`EPC device byte out of range: ${n}`);
  }
  return n.toString(16).toUpperCase().padStart(EPC_BYTE_LEN, "0");
}

/** Whether the counter has exhausted all 256 device bytes. */
export function isEpcByteExhausted(nextCounter: number): boolean {
  return nextCounter - 1 >= MAX_EPC_BYTE;
}
