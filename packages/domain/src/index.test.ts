import { expect, test } from "vitest";
import { DOMAIN_PACKAGE } from "./index";

test("package loads", () => {
  expect(DOMAIN_PACKAGE).toBe("@rfid/domain");
});
