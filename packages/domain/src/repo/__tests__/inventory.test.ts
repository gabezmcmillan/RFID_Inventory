import { describe, expect, test } from "vitest";

import {
  compareInventory,
  deliverUnits,
  inventoryTree,
  listEvents,
  receiveShipment,
  recordInventory,
} from "../../index";
import { openTestDb } from "../../testing/openTestDb";

describe("inventory", () => {
  test("a sweep of a delivered tag flags it and excludes it from counts", async () => {
    const db = await openTestDb();
    const epc = "AA" + "0".repeat(22);
    await receiveShipment(db, [epc], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    await deliverUnits(db, epc); // fully delivered (remaining 0)
    const res = await recordInventory(db, [epc]);
    expect(res.flagged).toHaveLength(1);
    expect(res.flagged[0]?.epc).toBe(epc);
    expect(res.flagged[0]?.flag).toContain("Checked out");
    expect(res.flagged[0]?.flag).toContain("detected in sweep");
    expect(res.counts["TSC"] ?? 0).toBe(0); // excluded from counts
    expect(res.total).toBe(1); // flagged counts toward total
  });

  test("an unknown EPC is reported and logs a COUNT event with item_type UNKNOWN", async () => {
    const db = await openTestDb();
    const unknown = "ZZ" + "0".repeat(22);
    const res = await recordInventory(db, [unknown]);
    expect(res.unknown).toEqual([unknown]);
    const events = await listEvents(db, "scan", unknown);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("COUNT");
    expect(events[0]?.item_type).toBe("UNKNOWN");
  });

  test("compareInventory partitions found/missing", async () => {
    const db = await openTestDb();
    const a = "AA" + "0".repeat(22);
    const b = "BB" + "0".repeat(22);
    await receiveShipment(db, [a, b], "TSC", "6", "BOL1", "Acme", { quantity: 1 });
    const res = await compareInventory(db, [a]); // only `a` scanned
    expect(res.expected).toBe(2);
    expect(res.found_count).toBe(1);
    expect(res.missing_count).toBe(1);
    expect(res.missing[0]?.epc).toBe(b);
  });

  test("inventoryTree groups W.I.F. by item_name and others by BOL; statuses derive from qty vs capacity", async () => {
    const db = await openTestDb();
    // Two W.I.F. boxes with different component names, one TSC box.
    await receiveShipment(db, ["AA" + "0".repeat(22)], "W.I.F.", "6", "BOL1", "Acme", {
      item_name: "Bracket",
      quantity: 4,
    });
    await receiveShipment(db, ["BB" + "0".repeat(22)], "W.I.F.", "6", "BOL1", "Acme", {
      item_name: "Plate",
      quantity: 4,
    });
    await receiveShipment(db, ["CC" + "0".repeat(22)], "TSC", "6", "BOL1", "Acme", {
      quantity: 4,
    });
    // Partially draw the TSC box so its status is Partial.
    await deliverUnits(db, "CC" + "0".repeat(22), 1);

    const tree = await inventoryTree(db, "bol");
    const wif = tree.types.find((t) => t.item_type === "W.I.F.");
    expect(wif?.named).toBe(true);
    // Named type groups by item_name, not BOL.
    expect(wif?.groups.map((g) => g.value).sort()).toEqual(["Bracket", "Plate"]);
    const tsc = tree.types.find((t) => t.item_type === "TSC");
    expect(tsc?.named).toBe(false);
    expect(tsc?.groups[0]?.value).toBe("BOL1");
    expect(tsc?.groups[0]?.status).toBe("Partial"); // 3 of 4 remaining
    expect(tsc?.groups[0]?.qty).toBe(3);
    expect(tsc?.groups[0]?.total).toBe(4);
  });
});
