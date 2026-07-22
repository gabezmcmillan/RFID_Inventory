import { beforeEach, describe, expect, test } from "vitest";

import { finderMask, finderRestore, ReaderSession } from "./index.js";
import type { ReaderEvent } from "./index.js";

/** Recorded `send` calls + captured `emit` events, with a controllable clock. */
interface Harness {
  readonly sent: string[];
  readonly events: ReaderEvent[];
  now: () => number;
  advance(seconds: number): void;
  readonly session: ReaderSession;
}

function harness(): Harness {
  const sent: string[] = [];
  const events: ReaderEvent[] = [];
  let t = 1000;
  const now = () => t;
  const advance = (s: number) => {
    t += s;
  };
  const session = new ReaderSession({ send: (c) => sent.push(c), emit: (e) => events.push(e), now });
  return { sent, events, now, advance, session };
}

const EPC_A = "AAAA00000000000000000000";
const EPC_B = "BBBB00000000000000000000";

describe("reader protocol", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  // 1. Strongest-RSSI EPC wins a single-mode scan; candidates counts both.
  test("checkin picks strongest-RSSI EPC and reports candidates", () => {
    h.session.setMode("checkin");
    h.sent.length = 0; // drop the mode side-effect commands for this assertion
    h.session.feed(`EP:${EPC_A}\r\nRI:-52\r\nEP:${EPC_B}\r\nRI:-70\r\n`);
    h.advance(0.7);
    h.session.tick();

    const scans = h.events.filter((e) => e.event === "scan");
    expect(scans).toHaveLength(1);
    const scan = scans[0]!;
    expect(scan.event).toBe("scan");
    if (scan.event === "scan") {
      expect(scan.epc).toBe(EPC_A); // -52 dBm is stronger than -70
      expect(scan.candidates).toBe(2);
      expect(scan.reads).toBe(1);
      expect(scan.rssi).toBe(-52);
    }
  });

  // 2. No RSSI captured → most-read EPC wins.
  test("no RSSI falls back to most-read EPC", () => {
    h.session.setMode("checkin");
    h.session.feed(`EP:${EPC_A}\r\nEP:${EPC_A}\r\nEP:${EPC_A}\r\nEP:${EPC_B}\r\n`);
    h.advance(0.7);
    h.session.tick();

    const scan = h.events.find((e) => e.event === "scan");
    expect(scan).toBeDefined();
    if (scan && scan.event === "scan") {
      expect(scan.epc).toBe(EPC_A); // read 3× vs 1×
      expect(scan.reads).toBe(3);
      expect(scan.rssi).toBeUndefined();
    }
  });

  // 3. Inventory: sorted distinct EPCs + one live per new EPC.
  test("inventory emits sorted distinct EPCs and one live per new EPC", () => {
    h.session.setMode("inventory");
    h.session.feed(`EP:${EPC_B}\r\nEP:${EPC_A}\r\nEP:${EPC_B}\r\n`);

    const lives = h.events.filter((e) => e.event === "live");
    expect(lives).toHaveLength(2);
    if (lives[0]!.event === "live" && lives[1]!.event === "live") {
      expect(lives[0]!.epc).toBe(EPC_B);
      expect(lives[0]!.distinct).toBe(1);
      expect(lives[1]!.epc).toBe(EPC_A);
      expect(lives[1]!.distinct).toBe(2);
    }

    h.advance(0.7);
    h.session.tick();
    const inv = h.events.find((e) => e.event === "inventory");
    expect(inv).toBeDefined();
    if (inv && inv.event === "inventory") {
      expect(inv.epcs).toEqual([EPC_A, EPC_B]); // sorted
      expect(inv.distinct).toBe(2);
    }
  });

  // 4. Finder select-mask and restore command strings match the excerpt exactly.
  test("finder mode sends exact select-mask and restore strings", () => {
    const target = "E00401D00123456789ABCDEF";
    h.session.setMode("finder", { targetEpc: target });

    // Bit length = 24 hex chars * 4 = 96 = 0x60, two-digit uppercase hex.
    const expectedMask = finderMask(target);
    expect(expectedMask).toBe(
      ".iv -io off -ql sl -sa 0 -st sl -sb epc " +
        "-so 0020 -sd E00401D00123456789ABCDEF -sl 60 -ie on " +
        "-qs s0 -qa fix -qv 0 -n\r\n",
    );
    expect(h.sent).toContain(expectedMask);

    h.sent.length = 0;
    h.session.setMode("inventory");
    expect(h.sent).toContain(finderRestore());
    expect(finderRestore()).toBe(
      ".iv -io on -ql all -st s1 -sl 00 -so 0000 -qs s1 -qa dyn -qv 4 -n\r\n",
    );
  });

  // 5. Finder RI mapping: -80→0, -40→100, -60→50; SW:off → finder_reset.
  test("finder maps RSSI to 0-100% and resets on SW:off", () => {
    const target = EPC_A;
    h.session.setMode("finder", { targetEpc: target });
    h.events.length = 0;

    h.session.feed(`EP:${EPC_A}\r\nRI:-80\r\n`);
    h.session.feed(`EP:${EPC_A}\r\nRI:-40\r\n`);
    h.session.feed(`EP:${EPC_A}\r\nRI:-60\r\n`);
    h.session.feed(`SW:off\r\n`);

    const finder = h.events.filter((e) => e.event === "finder");
    expect(finder).toHaveLength(3);
    if (finder[0]!.event === "finder") expect(finder[0]!.percent).toBe(0);
    if (finder[1]!.event === "finder") expect(finder[1]!.percent).toBe(100);
    if (finder[2]!.event === "finder") expect(finder[2]!.percent).toBe(50);

    const reset = h.events.filter((e) => e.event === "finder_reset");
    expect(reset).toHaveLength(1);
  });

  // 6. onConnected after setMode("checkout") replays .sa -aon, power, RSSI-on, beep-on.
  test("onConnected replays .sa -aon plus checkout side-effects", () => {
    h.session.setMode("checkout");
    h.sent.length = 0; // ignore the initial mode side-effects
    h.events.length = 0;

    h.session.onConnected();

    expect(h.sent[0]).toBe(".sa -aon\r\n");
    expect(h.sent).toContain(".iv -o10 -n\r\n"); // check power = 10 dBm
    expect(h.sent).toContain(".iv -r on -n\r\n"); // RSSI on for checkout
    expect(h.sent).toContain(".iv -al on -n\r\n"); // beep on (not finder)
    const status = h.events.find((e) => e.event === "status");
    expect(status).toBeDefined();
    if (status && status.event === "status") {
      expect(status.connected).toBe(true);
    }
  });

  // 7. Partial line chunks across feed() calls parse correctly.
  test("partial line chunks across feed calls parse correctly", () => {
    h.session.setMode("checkin");
    h.session.feed("EP:");
    h.session.feed(`${EPC_A}\r`);
    h.session.feed("\nRI:-52");
    h.session.feed("\r\n");
    h.advance(0.7);
    h.session.tick();

    const scan = h.events.find((e) => e.event === "scan");
    expect(scan).toBeDefined();
    if (scan && scan.event === "scan") {
      expect(scan.epc).toBe(EPC_A);
      expect(scan.rssi).toBe(-52);
    }
  });

  // 8. Mode change mid-burst discards accumulation (no stray finalize).
  test("mode change mid-burst discards accumulation", () => {
    h.session.setMode("checkin");
    h.session.feed(`EP:${EPC_A}\r\nRI:-52\r\n`);
    // Switching mode mid-burst must drop the partial burst.
    h.session.setMode("inventory");
    h.events.length = 0;
    h.sent.length = 0;

    h.advance(0.7);
    h.session.tick();

    // No scan event (the checkin burst was discarded); no inventory either
    // (the inventory burst is empty).
    expect(h.events.filter((e) => e.event === "scan")).toHaveLength(0);
    expect(h.events.filter((e) => e.event === "inventory")).toHaveLength(0);
  });
});
