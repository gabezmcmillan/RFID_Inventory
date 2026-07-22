import { expect, test } from "vitest";

import { STATUS_IN } from "./index";
import { openTestDb } from "./testing/openTestDb.js";

test("package re-exports the domain surface", async () => {
  const db = await openTestDb();
  expect(STATUS_IN).toBe("In Warehouse");
});
