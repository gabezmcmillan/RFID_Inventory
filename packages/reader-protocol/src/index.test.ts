import { expect, test } from "vitest";
import { READER_PROTOCOL_PACKAGE } from "./index";

test("package loads", () => {
  expect(READER_PROTOCOL_PACKAGE).toBe("@rfid/reader-protocol");
});
