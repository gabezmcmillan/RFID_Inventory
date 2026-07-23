import { describe, expect, test } from "vitest";

import { IntakeSession, createBolDoc, listEvents, NO_SHIPMENT_ARMED, receiveShipment, type PrintDeps } from "../index";
import type { ItemFields } from "../index";
import { openTestDb } from "../testing/openTestDb";

const EPC = "AAAA11112222333344445555";

describe("IntakeSession", () => {
  test("a scan with nothing armed returns the no-shipment message", async () => {
    const db = await openTestDb();
    const session = new IntakeSession();
    const res = await session.checkInScanned(db, EPC);
    expect(res).toEqual({ ok: false, message: NO_SHIPMENT_ARMED });
  });

  test("arm → scan records the box under the armed shipment fields", async () => {
    const db = await openTestDb();
    const session = new IntakeSession();
    session.arm("TSC", { building_number: "6", bol_number: "TEST1" });
    session.setItemFields({ quantity: 5 });
    const res = await session.checkInScanned(db, EPC);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.added).toBe(1);
    expect(res.added_units).toBe(5);
    expect(res.qty).toBe(5);
    expect(res.message).toBe("Received 1 box (5 units) of TSC (BOL TEST1, 6).");
    // The session stays armed for the next tag.
    expect(session.getArmed()).not.toBeNull();
  });

  test("re-arm resets the per-unit item fields", async () => {
    const db = await openTestDb();
    const session = new IntakeSession();
    session.arm("TSC", { building_number: "6", bol_number: "BOL1" });
    session.setItemFields({ quantity: 9, sku: "OLD" });
    // Re-arm: item fields must be cleared so the stale quantity/sku don't leak.
    session.arm("TSC", { building_number: "6", bol_number: "BOL2" });
    const res = await session.checkInScanned(db, "BBBB" + "0".repeat(20));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.added_units).toBe(1); // default quantity, not 9
    expect(res.sku).toBe(""); // not "OLD"
    expect(res.bol_number).toBe("BOL2");
  });

  test("amend filters out unknown keys and applies only amendable fields", async () => {
    const db = await openTestDb();
    const epc = "CCCC" + "0".repeat(20);
    await receiveShipment(db, [epc], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    const session = new IntakeSession();
    // Simulate a UI payload carrying non-amendable keys (item_type, bol_number)
    // alongside the amendable ones; amend must drop the non-amendable keys.
    const payload = {
      item_name: "widget",
      sku: "SKU1",
      quantity: 10,
      item_type: "CDU",
      bol_number: "OTHER",
    } as unknown as ItemFields;
    const res = await session.amend(db, epc, payload);
    expect(res.ok).toBe(true);
    expect(res.tag?.quantity).toBe(10);
    expect(res.tag?.remaining).toBe(10);
    expect(res.tag?.item_name).toBe("widget");
    expect(res.tag?.sku).toBe("SKU1");
    expect(res.tag?.item_type).toBe("TSC"); // unchanged
    expect(res.tag?.bol_number).toBe("BOL1"); // unchanged
  });

  test("bol_doc_id is stored as a text id or null", async () => {
    const db = await openTestDb();
    const doc = await createBolDoc(db, "B1", "b1.pdf");
    const session = new IntakeSession();
    session.arm("TSC", { building_number: "6", bol_number: "B1", bol_doc_id: doc.id });
    const res = await session.checkInScanned(db, "DDDD" + "0".repeat(20));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bol_doc_id).toBe(doc.id);

    session.arm("TSC", { building_number: "6", bol_number: "B2", bol_doc_id: "" });
    const res2 = await session.checkInScanned(db, "EEEE" + "0".repeat(20));
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.bol_doc_id).toBeNull();
  });

  test("checkInPrinted with nothing armed returns the no-shipment message", async () => {
    const db = await openTestDb();
    const session = new IntakeSession();
    const deps: PrintDeps = { cloudBaseUrl: "", printLabel: async () => {} };
    const res = await session.checkInPrinted(db, deps, 3);
    expect(res).toEqual({ ok: false, message: NO_SHIPMENT_ARMED });
  });

  test("checkInPrinted records only the labels that printed; partial print appends the stop suffix", async () => {
    const db = await openTestDb();
    const session = new IntakeSession();
    session.arm("TSC", { building_number: "6", bol_number: "BOL1", vendor: "Acme" });
    session.setItemFields({ quantity: 4 });
    const sent: string[] = [];
    let calls = 0;
    const deps: PrintDeps = {
      cloudBaseUrl: "",
      printLabel: async (zpl: string) => {
        calls += 1;
        if (calls === 3) throw new Error("paper jam");
        sent.push(zpl);
      },
    };
    const res = await session.checkInPrinted(db, deps, 3);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.printed).toBe(2);
    expect(res.added).toBe(2);
    expect(res.added_units).toBe(8); // 2 boxes × 4 units
    expect(res.message).toContain("Printing stopped after 2 of 3 labels: paper jam");
    // Exactly 2 tags recorded → 2 IN events, no phantom third.
    const events = await listEvents(db, "checkin");
    expect(events.filter((e) => e.action === "IN")).toHaveLength(2);
    // The two printed EPCs are the ones minted first; the third was never sent.
    expect(sent).toHaveLength(2);
  });

  test("checkInPrinted with all-fail records zero tags and no IN events (no phantom inventory)", async () => {
    const db = await openTestDb();
    const session = new IntakeSession();
    session.arm("TSC", { building_number: "6", bol_number: "BOL1", vendor: "Acme" });
    session.setItemFields({ quantity: 4 });
    const deps: PrintDeps = {
      cloudBaseUrl: "https://cloud.example.com",
      printLabel: async () => {
        throw new Error("printer unreachable");
      },
    };
    const res = await session.checkInPrinted(db, deps, 3);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toBe("Label not printed: printer unreachable");
    // Zero tags and zero IN events — a dead printer never creates inventory.
    const events = await listEvents(db, "checkin");
    expect(events).toHaveLength(0);
  });
});
