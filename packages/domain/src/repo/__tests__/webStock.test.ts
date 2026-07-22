import { describe, expect, test } from "vitest";

import {
  createCartRequest,
  listOrders,
  receiveShipment,
  stockRows,
  counts,
  buildings,
  deliverUnits,
} from "../../index";
import { openTestDb } from "../../testing/openTestDb.js";

const E = (s: string) => s + "0".repeat(24 - s.length);

describe("webStock", () => {
  test("plain-type stock rows aggregate units across BOLs per building with a BOL breakdown", async () => {
    const db = await openTestDb();
    await receiveShipment(db, [E("AA")], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    await receiveShipment(db, [E("BB")], "TSC", "6", "BOL2", "Beta", { quantity: 6 });
    await receiveShipment(db, [E("CC")], "TSC", "7", "BOL1", "Acme", { quantity: 2 });
    const rows = await stockRows(db);
    const bldg6 = rows.find((r) => r.item_type === "TSC" && r.building === "6");
    const bldg7 = rows.find((r) => r.item_type === "TSC" && r.building === "7");
    expect(bldg6?.units).toBe(10);
    expect(bldg6?.boxes).toBe(2);
    expect(bldg6?.groups).toHaveLength(2);
    expect(bldg6?.vendors.sort()).toEqual(["Acme", "Beta"]);
    expect(bldg7?.units).toBe(2);
    expect(bldg7?.groups).toHaveLength(1);
  });

  test("W.I.F. collapses to one row whose drill-down is components, status In Warehouse / Partial", async () => {
    const db = await openTestDb();
    await receiveShipment(db, [E("AA")], "W.I.F.", "6", "BOL1", "Acme", { item_name: "Bracket", quantity: 4 });
    await receiveShipment(db, [E("BB")], "W.I.F.", "6", "BOL1", "Acme", { item_name: "Plate", quantity: 6 });
    // Draw 2 from Bracket -> Partial.
    await deliverUnits(db, E("AA"), 2);
    const rows = await stockRows(db);
    expect(rows).toHaveLength(1);
    const wif = rows[0]!;
    expect(wif.named).toBe(true);
    expect(wif.building).toBe("");
    expect(wif.units).toBe(8);
    expect(wif.components).toHaveLength(2);
    const bracket = wif.components.find((c) => c.item_name === "Bracket")!;
    const plate = wif.components.find((c) => c.item_name === "Plate")!;
    expect(bracket.units).toBe(2);
    expect(bracket.capacity).toBe(4);
    expect(bracket.status).toBe("Partial");
    expect(plate.status).toBe("In Warehouse");
  });

  test("zero-remaining stock is absent from stock rows", async () => {
    const db = await openTestDb();
    await receiveShipment(db, [E("AA")], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    await deliverUnits(db, E("AA")); // fully delivered
    const rows = await stockRows(db);
    expect(rows.filter((r) => r.item_type === "TSC")).toHaveLength(0);
  });

  test("a valid cart creates rows sharing an order_ref with building = delivery building", async () => {
    const db = await openTestDb();
    await receiveShipment(db, [E("AA")], "TSC", "6", "BOL1", "Acme", { quantity: 10 });
    await receiveShipment(db, [E("BB")], "CDU", "7", "BOL2", "Beta", { quantity: 10 });
    const res = await createCartRequest(db, "Jane", "j@x", "Site A", "note", "", [
      { item_type: "TSC", building: "6", quantity: 3, delivery_building: "7" },
      { item_type: "CDU", building: "7", quantity: 2, delivery_building: "8" },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ids).toHaveLength(2);
    expect(res.order_ref).toMatch(/^[0-9A-F]{6}$/);
    const orders = await listOrders(db);
    const order = orders.find((o) => o.order_ref === res.order_ref)!;
    expect(order.lines).toHaveLength(2);
    const tscLine = order.lines.find((l) => l.item_type === "TSC")!;
    const cduLine = order.lines.find((l) => l.item_type === "CDU")!;
    expect(tscLine.building).toBe("7"); // delivery building
    expect(cduLine.building).toBe("8");
    expect(tscLine.order_ref).toBe(cduLine.order_ref);
    expect(tscLine.requester).toBe("Jane");
    expect(tscLine.created_at).toMatch(/\+00:00$/); // UTC offset convention
  });

  test("two cart lines jointly exceeding one stock row both error (aggregate check)", async () => {
    const db = await openTestDb();
    await receiveShipment(db, [E("AA")], "TSC", "6", "BOL1", "Acme", { quantity: 5 });
    const res = await createCartRequest(db, "Jane", "", "", "", "", [
      { item_type: "TSC", building: "6", quantity: 3, delivery_building: "7" },
      { item_type: "TSC", building: "6", quantity: 3, delivery_building: "7" },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(2);
    expect(res.errors.every((e) => e.message.includes("Only 5 unit(s)"))).toBe(true);
    // No rows inserted.
    const orders = await listOrders(db);
    expect(orders).toHaveLength(0);
  });

  test("strict quantity: '2.5' and '0' are rejected", async () => {
    const db = await openTestDb();
    await receiveShipment(db, [E("AA")], "TSC", "6", "BOL1", "Acme", { quantity: 10 });
    const res = await createCartRequest(db, "Jane", "", "", "", "", [
      { item_type: "TSC", building: "6", quantity: "2.5", delivery_building: "7" },
      { item_type: "TSC", building: "6", quantity: "0", delivery_building: "7" },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(2);
    expect(res.errors.every((e) => e.message.includes("whole number of 1 or more"))).toBe(true);
  });

  test("missing item type and missing delivery building each produce their own line error", async () => {
    const db = await openTestDb();
    await receiveShipment(db, [E("AA")], "TSC", "6", "BOL1", "Acme", { quantity: 10 });
    const res = await createCartRequest(db, "Jane", "", "", "", "", [
      { item_type: "", building: "6", quantity: 1, delivery_building: "7" },
      { item_type: "TSC", building: "6", quantity: 1, delivery_building: "" },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(2);
    expect(res.errors.some((e) => e.message.includes("item type is required"))).toBe(true);
    expect(res.errors.some((e) => e.message.includes("delivery building is required"))).toBe(true);
  });

  test("empty cart and missing requester are rejected before any write", async () => {
    const db = await openTestDb();
    const empty = await createCartRequest(db, "Jane", "", "", "", "", []);
    expect(empty.ok).toBe(false);
    const noName = await createCartRequest(db, "", "", "", "", "", [
      { item_type: "TSC", building: "6", quantity: 1, delivery_building: "7" },
    ]);
    expect(noName.ok).toBe(false);
    if (noName.ok) return;
    expect(noName.message).toContain("name is required");
  });

  test("listOrders groups open orders first, then newest; header building only when all lines agree", async () => {
    const db = await openTestDb();
    await receiveShipment(db, [E("AA")], "TSC", "6", "BOL1", "Acme", { quantity: 10 });
    await receiveShipment(db, [E("BB")], "CDU", "7", "BOL2", "Beta", { quantity: 10 });
    // Order 1: two lines to the same delivery building.
    const o1 = await createCartRequest(db, "Jane", "", "", "", "", [
      { item_type: "TSC", building: "6", quantity: 1, delivery_building: "7" },
      { item_type: "CDU", building: "7", quantity: 1, delivery_building: "7" },
    ]);
    // Order 2: two lines to different delivery buildings.
    const o2 = await createCartRequest(db, "Jane", "", "", "", "", [
      { item_type: "TSC", building: "6", quantity: 1, delivery_building: "8" },
      { item_type: "CDU", building: "7", quantity: 1, delivery_building: "7" },
    ]);
    const orders = await listOrders(db);
    expect(orders).toHaveLength(2);
    // Both open; newest (o2) first by max_id.
    expect(orders[0]?.order_ref).toBe(o2.ok ? o2.order_ref : "");
    expect(orders[1]?.order_ref).toBe(o1.ok ? o1.order_ref : "");
    const sameBldg = orders.find((o) => o.order_ref === (o1.ok ? o1.order_ref : ""))!;
    const diffBldg = orders.find((o) => o.order_ref === (o2.ok ? o2.order_ref : ""))!;
    expect(sameBldg.building).toBe("7");
    expect(diffBldg.building).toBe("");
  });

  test("counts reports warehouse units and open request count", async () => {
    const db = await openTestDb();
    await receiveShipment(db, [E("AA")], "TSC", "6", "BOL1", "Acme", { quantity: 4 });
    await receiveShipment(db, [E("BB")], "TSC", "6", "BOL1", "Acme", { quantity: 6 });
    await deliverUnits(db, E("AA"), 2); // 2 delivered, 8 remain
    await createCartRequest(db, "Jane", "", "", "", "", [
      { item_type: "TSC", building: "6", quantity: 1, delivery_building: "7" },
    ]);
    const c = await counts(db);
    expect(c.units).toBe(8);
    expect(c.requests_pending).toBe(1);
  });

  test("buildings lists every distinct building ever seen", async () => {
    const db = await openTestDb();
    await receiveShipment(db, [E("AA")], "TSC", "6", "BOL1", "Acme", { quantity: 1 });
    await receiveShipment(db, [E("BB")], "TSC", "8", "BOL2", "Beta", { quantity: 1 });
    const b = await buildings(db);
    expect(b).toEqual(["6", "8"]);
  });
});
