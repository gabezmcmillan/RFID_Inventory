import { expect, test } from "vitest";

import { STATUS_IN, applySchema, openTestDb } from "./index";

test("package re-exports the domain surface", async () => {
  const db = await openTestDb();
  await applySchema(db);
  expect(STATUS_IN).toBe("In Warehouse");
});
