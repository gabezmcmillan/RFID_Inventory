import { describe, expect, test } from "vitest";

import type { DeviceWithLinker } from "@/lib/devices";
import { applyDeviceOptimisticUpdate } from "@/app/admin/devices/queries";

const NOW = "2026-07-23T00:00:00.000Z";

function row(over: Partial<DeviceWithLinker> = {}): DeviceWithLinker {
  return {
    id: "dev-1",
    user_id: "u-1",
    session_id: "s-1",
    epc_byte: "00",
    label: "Scanner 1",
    active: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    revoked_at: null,
    unlinked_at: null,
    deactivated_at: null,
    last_seen_at: null,
    last_sync_at: null,
    linked_by_email: "ops@acme.com",
    linked_by_name: "Ops",
    ...over,
  };
}

describe("applyDeviceOptimisticUpdate — pure optimistic reducer", () => {
  test("rename updates only the matching device's label", () => {
    const devices = [row({ id: "a", label: "A" }), row({ id: "b", label: "B" })];
    const next = applyDeviceOptimisticUpdate(devices, "b", { kind: "rename", label: "B2" }, NOW);
    expect(next.map((d) => d.label)).toEqual(["A", "B2"]);
    // Original array is untouched (immutability).
    expect(devices[1].label).toBe("B");
  });

  test("deactivate flips active to 0 and stamps deactivated_at", () => {
    const next = applyDeviceOptimisticUpdate([row()], "dev-1", { kind: "deactivate" }, NOW);
    expect(next[0].active).toBe(0);
    expect(next[0].deactivated_at).toBe(NOW);
    expect(next[0].revoked_at).toBeNull();
  });

  test("reactivate flips active to 1 and clears deactivated_at", () => {
    const next = applyDeviceOptimisticUpdate(
      [row({ active: 0, deactivated_at: "2026-07-01T00:00:00.000Z" })],
      "dev-1",
      { kind: "reactivate" },
      NOW,
    );
    expect(next[0].active).toBe(1);
    expect(next[0].deactivated_at).toBeNull();
  });

  test("revoke flips active to 0 and stamps revoked_at", () => {
    const next = applyDeviceOptimisticUpdate([row()], "dev-1", { kind: "revoke" }, NOW);
    expect(next[0].active).toBe(0);
    expect(next[0].revoked_at).toBe(NOW);
    expect(next[0].deactivated_at).toBeNull();
  });

  test("a non-matching deviceId is a no-op (same rows, new array)", () => {
    const devices = [row({ id: "a" })];
    const next = applyDeviceOptimisticUpdate(devices, "other", { kind: "deactivate" }, NOW);
    expect(next).toEqual(devices);
    expect(next).not.toBe(devices);
  });
});
