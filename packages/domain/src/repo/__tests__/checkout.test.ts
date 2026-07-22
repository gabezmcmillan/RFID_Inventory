import { describe, expect, test } from "vitest";

import { deliverUnits, listEvents, lookupForCheckout, receiveShipment } from "../../index";
import { openTestDb } from "../../testing/openTestDb.js";

describe("checkout", () => {
  test("a full draw marks the box Delivered", async () => {
    const db = await openTestDb();
    const epc = "AA" + "0".repeat(22);
    await receiveShipment(db, [epc], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    const res = await deliverUnits(db, epc); // whole box
    expect(res.ok).toBe(true);
    expect(res.box_remaining).toBe(0);
    expect(res.box_status).toBe("Delivered");
    expect(res.delivered).toBe(4);
    expect(res.delivered_at).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  test("a partial draw marks the box Partial", async () => {
    const db = await openTestDb();
    const epc = "BB" + "0".repeat(22);
    await receiveShipment(db, [epc], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    const res = await deliverUnits(db, epc, 1);
    expect(res.ok).toBe(true);
    expect(res.box_remaining).toBe(3);
    expect(res.box_status).toBe("Partial");
  });

  test("amount is clamped to [1, remaining]", async () => {
    const db = await openTestDb();
    const epc = "CC" + "0".repeat(22);
    const epc2 = "DD" + "0".repeat(22);
    await receiveShipment(db, [epc], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    await receiveShipment(db, [epc2], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    const tooMany = await deliverUnits(db, epc, 99); // clamped to remaining (4)
    expect(tooMany.delivered).toBe(4);
    const zero = await deliverUnits(db, epc2, 0); // 0 -> asQuantity -> 1
    expect(zero.delivered).toBe(1);
    expect(zero.box_remaining).toBe(3);
  });

  test("destination != received building sets the exact flag text and logs FLAG", async () => {
    const db = await openTestDb();
    const epc = "DD" + "0".repeat(22);
    await receiveShipment(db, [epc], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    const res = await deliverUnits(db, epc, 2, "7");
    expect(res.flag).toBe("Checked out to Bldg 7 but received for Bldg 6");
    const events = await listEvents(db, "all", epc);
    const actions = events.map((e) => e.action);
    expect(actions).toContain("FLAG");
  });

  test("an already-empty box returns ok:false", async () => {
    const db = await openTestDb();
    const epc = "EE" + "0".repeat(22);
    await receiveShipment(db, [epc], "TSC", "6", "BOL1", "Acme", { quantity: 2 });
    await deliverUnits(db, epc); // fully delivered
    const lookup = await lookupForCheckout(db, epc);
    expect(lookup.ok).toBe(false);
    expect(lookup.remaining).toBe(0);
    const res = await deliverUnits(db, epc, 1);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("already fully delivered");
  });
});
