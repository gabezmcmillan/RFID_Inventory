import { describe, expect, it } from "vitest";
import { checkSchemaVersion } from "../schemaVersion";

describe("checkSchemaVersion", () => {
  it("is compatible when remote equals supported", () => {
    expect(checkSchemaVersion(5, 5)).toEqual({ ok: true });
  });

  it("is compatible when remote is behind supported", () => {
    expect(checkSchemaVersion(5, 3)).toEqual({ ok: true });
  });

  it("blocks when the server is ahead of this build", () => {
    expect(checkSchemaVersion(5, 6)).toEqual({ ok: false, reason: "upgrade-required" });
    expect(checkSchemaVersion(5, 99)).toEqual({ ok: false, reason: "upgrade-required" });
  });

  it("is compatible when the remote version is not yet known", () => {
    expect(checkSchemaVersion(5, null)).toEqual({ ok: true });
  });
});
