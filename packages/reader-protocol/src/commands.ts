/**
 * TSL ASCII 2.0 command builders.
 *
 * Every builder returns the exact command string the reader expects, including
 * the trailing `\r\n`. The constants mirror `apps/warehouse/config.py` so tuning
 * (power range, finder scale, quiet gap) lives here — mirroring `config.py` —
 * not at call sites. See the plan's maintenance notes.
 */

/** Minimum reader output power (dBm). `config.py:READER_POWER_MIN_DBM`. */
export const POWER_MIN = 10;

/** Maximum reader output power (dBm). `config.py:READER_POWER_MAX_DBM`. */
export const POWER_MAX = 29;

/** Default check-in/check-out power (dBm). `config.py:CHECK_POWER_DBM`. */
export const CHECK_POWER_DEFAULT = 10;

/** Inventory/finder power (dBm). `config.py:INVENTORY_POWER_DBM`. */
export const INVENTORY_POWER = 29;

/**
 * Seconds with no `EP:`/`OK:` activity after which a burst is finalized.
 * `config.py:QUIET_GAP_SECONDS`.
 */
export const QUIET_GAP_SECONDS = 0.6;

/** Finder RSSI (dBm) that maps to 0%. `config.py:FINDER_RSSI_MIN_DBM`. */
export const FINDER_RSSI_MIN_DBM = -80;

/** Finder RSSI (dBm) that maps to 100%. `config.py:FINDER_RSSI_MAX_DBM`. */
export const FINDER_RSSI_MAX_DBM = -40;

/** Clamp a dBm value to the reader's valid power range. */
export function clampPower(dbm: number): number {
  const v = Math.trunc(dbm);
  return Math.max(POWER_MIN, Math.min(POWER_MAX, v));
}

/** `.sa -aon\r\n` — enable async switch (trigger) notifications. */
export function switchNotifications(): string {
  return ".sa -aon\r\n";
}

/** `.iv -o<nn> -n\r\n` — set inventory output power (dBm), take no action. */
export function setPower(dbm: number): string {
  return `.iv -o${clampPower(dbm)} -n\r\n`;
}

/** `.iv -r on|off -n\r\n` — toggle RSSI (`RI:`) output, take no action. */
export function setRssiOutput(on: boolean): string {
  return `.iv -r ${on ? "on" : "off"} -n\r\n`;
}

/** `.iv -al on|off -n\r\n` — toggle the read-success beep, take no action. */
export function setBeep(on: boolean): string {
  return `.iv -al ${on ? "on" : "off"} -n\r\n`;
}

/** `.al -boff -von -dlon\r\n` — fire a long vibrate, buzzer off. `config.py:ALERT_VIBRATE_CMD`. */
export function alertFire(): string {
  return ".al -boff -von -dlon\r\n";
}

/** `.al -bon -dsho -von -n\r\n` — restore default alert params, no action. `config.py:ALERT_RESTORE_CMD`. */
export function alertRestore(): string {
  return ".al -bon -dsho -von -n\r\n";
}

/**
 * `.iv` constrained to a single target EPC via a Gen2 Select mask, for finder
 * mode. `want` is the uppercase hex EPC. The bit length is the EPC's hex length
 * × 4, formatted as two-digit uppercase hex. Byte-for-byte with
 * `reader.py:363-378`.
 */
export function finderMask(epc: string): string {
  const bits = epc.length * 4;
  const len = bits.toString(16).toUpperCase().padStart(2, "0");
  return (
    `.iv -io off -ql sl -sa 0 -st sl -sb epc ` +
    `-so 0020 -sd ${epc} -sl ${len} -ie on ` +
    `-qs s0 -qa fix -qv 0 -n\r\n`
  );
}

/** Restore default all-tag inventory (no select, dynamic Q, S1). `reader.py:375-378`. */
export function finderRestore(): string {
  return ".iv -io on -ql all -st s1 -sl 00 -so 0000 -qs s1 -qa dyn -qv 4 -n\r\n";
}
