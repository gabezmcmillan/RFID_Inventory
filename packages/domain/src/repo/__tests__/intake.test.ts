import { describe, expect, test } from "vitest";

import { allocateEpcs, amendCheckin, receiveShipment } from "../../index";
import { openTestDb } from "../../testing/openTestDb.js";

describe("intake", () => {
  test("receiving 3 EPCs reports the group qty as the sum of units", async () => {
    const db = await openTestDb();
    const epcs = ["AA" + "0".repeat(22), "BB" + "0".repeat(22), "CC" + "0".repeat(22)];
    const res = await receiveShipment(db, epcs, "TSC", "6", "BOL1", "Acme", {
      quantity: 5,
    });
    expect(res.ok).toBe(true);
    expect(res.added).toBe(3);
    expect(res.added_units).toBe(15);
    expect(res.duplicates).toEqual([]);
    expect(res.qty).toBe(15); // SUM(remaining) across the 3 boxes
    expect(res.message).toBe("Received 3 boxes (15 units) of TSC (BOL BOL1, 6).");
    expect(res.epc).toBe(epcs[0]);
  });

  test("duplicate EPCs are reported and not re-inserted", async () => {
    const db = await openTestDb();
    const epc = "DD" + "0".repeat(22);
    await receiveShipment(db, [epc], "TSC", "6", "BOL1", "Acme", { quantity: 2 });
    const res = await receiveShipment(db, [epc, "EE" + "0".repeat(22)], "TSC", "6", "BOL1", "Acme", {
      quantity: 2,
    });
    expect(res.added).toBe(1);
    expect(res.duplicates).toEqual([epc]);
    expect(res.qty).toBe(4); // 2 (first box) + 2 (new box)
    expect(res.message).toContain("1 already on file.");
  });

  test("amending quantity resets remaining", async () => {
    const db = await openTestDb();
    const epc = "FF" + "0".repeat(22);
    await receiveShipment(db, [epc], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    // Simulate a partial drawdown so remaining != quantity.
    const { deliverUnits } = await import("../../index");
    await deliverUnits(db, epc, 1);
    const res = await amendCheckin(db, epc, { quantity: 10 });
    expect(res.ok).toBe(true);
    expect(res.tag?.remaining).toBe(10);
    expect(res.tag?.quantity).toBe(10);
    // amendCheckin does not touch status (Python leaves it as-is).
    expect(res.tag?.status).toBe("Partial");
  });

  test("allocateEpcs mints 24-hex unique EPCs with prefix and device id embedded", async () => {
    const db = await openTestDb();
    const epcs = await allocateEpcs(db, 3, "01");
    expect(epcs).toHaveLength(3);
    for (const epc of epcs) {
      expect(epc).toHaveLength(24);
      expect(epc.startsWith("42473031")).toBe(true);
      expect(epc.slice(8, 10)).toBe("01"); // device id
      expect(/^[0-9A-F]+$/.test(epc)).toBe(true);
    }
    expect(new Set(epcs).size).toBe(3);
  });

  test("allocateEpcs skips an EPC that already exists in tags", async () => {
    const db = await openTestDb();
    // Pre-create the tag whose EPC allocateEpcs would mint first (serial 1, device 01).
    const colliding = "42473031" + "01" + "00000000000001";
    await receiveShipment(db, [colliding], "TSC", "6", "BOL1", "Acme", { quantity: 1 });
    const epcs = await allocateEpcs(db, 3, "01");
    expect(epcs).toHaveLength(3);
    expect(epcs).not.toContain(colliding); // serial 1 was skipped
    expect(new Set(epcs).size).toBe(3);
  });
});
