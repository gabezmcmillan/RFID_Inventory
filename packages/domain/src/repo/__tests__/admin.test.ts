import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { clearFlag, deliverUnits, receiveShipment, updateTag } from "../../index";
import { tags } from "../../index";
import { openTestDb } from "../../testing/openTestDb.js";

describe("admin", () => {
  test("updateTag status -> In Warehouse resets remaining/delivered_at/flag", async () => {
    const db = await openTestDb();
    const epc = "AA" + "0".repeat(22);
    await receiveShipment(db, [epc], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    await deliverUnits(db, epc, 2, "7"); // partial + mismatch flag
    const rows = await db
      .select({ flag: tags.flag, delivered_at: tags.delivered_at, remaining: tags.remaining, quantity: tags.quantity, status: tags.status })
      .from(tags)
      .where(eq(tags.epc, epc));
    const tag = rows[0];
    expect(tag?.flag).not.toBe("");
    const res = await updateTag(db, epc, { status: "In Warehouse" });
    expect(res.ok).toBe(true);
    expect(res.tag?.remaining).toBe(4); // reset to quantity
    expect(res.tag?.delivered_at).toBe("");
    expect(res.tag?.flag).toBe("");
    expect(res.tag?.status).toBe("In Warehouse");
  });

  test("updateTag remaining -> 0 derives Delivered and stamps delivered_at", async () => {
    const db = await openTestDb();
    const epc = "BB" + "0".repeat(22);
    await receiveShipment(db, [epc], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    const res = await updateTag(db, epc, { remaining: 0 });
    expect(res.tag?.status).toBe("Delivered");
    expect(res.tag?.remaining).toBe(0);
    expect(res.tag?.delivered_at).not.toBe("");
  });

  test("clearFlag clears the warning flag", async () => {
    const db = await openTestDb();
    const epc = "CC" + "0".repeat(22);
    await receiveShipment(db, [epc], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    await deliverUnits(db, epc, 1, "7"); // sets flag
    const res = await clearFlag(db, epc);
    expect(res.ok).toBe(true);
    expect(res.tag?.flag).toBe("");
  });
});
