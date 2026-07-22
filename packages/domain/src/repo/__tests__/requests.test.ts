import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import {
  createRequest,
  deliverUnits,
  fulfillRequest,
  listRequests,
  receiveShipment,
  setRequestStatus,
  tags,
} from "../../index";
import { openTestDb } from "../../testing/openTestDb.js";

async function seedBox(db: Awaited<ReturnType<typeof openTestDb>>, epc: string, qty = 2) {
  await receiveShipment(db, [epc], "TSC", "6", "BOL1", "Acme", { quantity: qty });
}

async function remaining(db: Awaited<ReturnType<typeof openTestDb>>, epc: string): Promise<number | undefined> {
  const rows = await db.select({ remaining: tags.remaining }).from(tags).where(eq(tags.epc, epc));
  return rows[0]?.remaining;
}

describe("requests", () => {
  test("createRequest inserts a pending request and lists it open-first", async () => {
    const db = await openTestDb();
    const a = await createRequest(db, { item_type: "TSC", quantity: 2, jobsite: "Site A" });
    expect(a.ok).toBe(true);
    expect(a.request?.status).toBe("pending");
    const b = await createRequest(db, { item_type: "TSC", quantity: 1, jobsite: "Site B" });
    await setRequestStatus(db, b.request!.id, "staging");
    const list = await listRequests(db);
    // staging before pending, then newest first.
    expect(list[0]?.status).toBe("staging");
    expect(list[1]?.status).toBe("pending");
  });

  test("the transition table keeps fulfilled unreachable via setRequestStatus", async () => {
    const db = await openTestDb();
    const r = await createRequest(db, { item_type: "TSC", quantity: 1 });
    const bad = await setRequestStatus(db, r.request!.id, "fulfilled");
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("cannot mark it fulfilled");
    // pending -> staging -> pending -> declined are allowed.
    expect((await setRequestStatus(db, r.request!.id, "staging")).ok).toBe(true);
    expect((await setRequestStatus(db, r.request!.id, "pending")).ok).toBe(true);
    expect((await setRequestStatus(db, r.request!.id, "declined")).ok).toBe(true);
  });

  test("fulfillRequest short-without-note rolls back (tag remaining unchanged) and returns note_required", async () => {
    const db = await openTestDb();
    const epc = "AA" + "0".repeat(22);
    await seedBox(db, epc, 2);
    const r = await createRequest(db, { item_type: "TSC", quantity: 5 }); // request more than available
    await setRequestStatus(db, r.request!.id, "staging");
    const before = await remaining(db, epc);
    const res = await fulfillRequest(db, r.request!.id, [{ epc, amount: 2, building: "6" }]);
    expect(res.ok).toBe(false);
    expect(res.note_required).toBe(true);
    const after = await remaining(db, epc);
    expect(after).toBe(before); // rolled back
    // Request is still staging (not fulfilled).
    const stillOpen = await listRequests(db, "staging");
    expect(stillOpen).toHaveLength(1);
  });

  test("a successful short fulfill decrements tags and sets handler_note 'N of M supplied -- note'", async () => {
    const db = await openTestDb();
    const epc = "BB" + "0".repeat(22);
    await seedBox(db, epc, 2);
    const r = await createRequest(db, { item_type: "TSC", quantity: 4 }); // short by 2
    await setRequestStatus(db, r.request!.id, "staging");
    const res = await fulfillRequest(
      db,
      r.request!.id,
      [{ epc, amount: 2, building: "6" }],
      "partial stock",
    );
    expect(res.ok).toBe(true);
    expect(res.delivered).toBe(2);
    expect(res.requested).toBe(4);
    expect(res.short).toBe(true);
    expect(res.request?.status).toBe("fulfilled");
    expect(res.request?.handler_note).toBe("2 of 4 supplied -- partial stock");
    expect(await remaining(db, epc)).toBe(0); // decremented
  });

  test("fulfillRequest with nothing delivered rolls back and reports nothing", async () => {
    const db = await openTestDb();
    const epc = "CC" + "0".repeat(22);
    await seedBox(db, epc, 2);
    await deliverUnits(db, epc); // fully delivered -> draw will fail
    const r = await createRequest(db, { item_type: "TSC", quantity: 1 });
    await setRequestStatus(db, r.request!.id, "staging");
    const res = await fulfillRequest(db, r.request!.id, [{ epc, amount: 1, building: "6" }]);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("Nothing was delivered");
  });
});
