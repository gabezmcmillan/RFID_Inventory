import { describe, expect, test } from "vitest";

import { listEvents, logEvent, receiveShipment } from "../../index";
import { openTestDb } from "../../testing/openTestDb.js";

describe("events", () => {
  test("listEvents('checkout') returns only OUT actions", async () => {
    const db = await openTestDb();
    const epc = "AA" + "0".repeat(22);
    await receiveShipment(db, [epc], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    // receiveShipment logged an IN; log a couple more actions.
    await logEvent(db, "OUT", epc, "TSC", "BOL1", "6", "Acme", "delivered 1 unit(s), 3 left");
    await logEvent(db, "COUNT", epc, "TSC", "BOL1", "6", "Acme", "4 unit(s)");
    const checkout = await listEvents(db, "checkout");
    expect(checkout.length).toBeGreaterThan(0);
    expect(checkout.every((e) => e.action === "OUT")).toBe(true);
  });

  test("listEvents('all') returns newest-first", async () => {
    const db = await openTestDb();
    await logEvent(db, "IN", "E1" + "0".repeat(22), "TSC");
    await logEvent(db, "OUT", "E2" + "0".repeat(22), "TSC");
    const all = await listEvents(db, "all");
    expect(all[0]?.action).toBe("OUT"); // newest first
    expect(all[1]?.action).toBe("IN");
  });
});
