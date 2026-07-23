"use client";

/**
 * TanStack Query hooks for the admin Devices page. The list is prefetched on
 * the server (see `admin/devices/page.tsx`) and dehydrated, so `useDevicesQuery`
 * renders instantly on first paint; refetches (invalidation, window focus) hit
 * `GET /api/admin/devices`. Mutations call the existing Server Actions in
 * `./actions` (no API redesign) and apply optimistic updates — the lifecycle
 * flips are deterministic, so the cache can be updated locally and the
 * authoritative list is refetched on settle.
 *
 * The optimistic update is a pure function ({@link applyDeviceOptimisticUpdate})
 * so it is unit-testable without a React tree.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { DeviceWithLinker } from "@/lib/devices";

import {
  deactivateDeviceAction,
  reactivateDeviceAction,
  renameDeviceAction,
  revokeDeviceAction,
} from "./actions";

/** The devices list query key (stable, serializable). */
export const devicesQueryKey = ["admin", "devices"] as const;

/** The shape cached under {@link devicesQueryKey}. */
export type DevicesList = DeviceWithLinker[];

/** Fetch the devices list from the read route (the client refetch path). */
async function fetchDevices(): Promise<DevicesList> {
  const res = await fetch("/api/admin/devices");
  if (!res.ok) {
    throw new Error(`Failed to load devices (${res.status})`);
  }
  return (await res.json()) as DevicesList;
}

/** The devices list query. Initial data is hydrated from the server prefetch. */
export function useDevicesQuery() {
  return useQuery({
    queryKey: devicesQueryKey,
    queryFn: fetchDevices,
  });
}

/** The optimistic change a mutation applies to a single device row. */
export type DeviceOptimisticChange =
  | { kind: "rename"; label: string }
  | { kind: "deactivate" }
  | { kind: "reactivate" }
  | { kind: "revoke" };

/**
 * Apply a lifecycle mutation optimistically to a devices list (pure, testable).
 * Returns a new array; the original is untouched. `now` is injected so tests are
 * deterministic.
 */
export function applyDeviceOptimisticUpdate(
  devices: DevicesList,
  deviceId: string,
  change: DeviceOptimisticChange,
  now: string,
): DevicesList {
  return devices.map((d) => {
    if (d.id !== deviceId) {
      return d;
    }
    switch (change.kind) {
      case "rename":
        return { ...d, label: change.label };
      case "deactivate":
        return { ...d, active: 0, deactivated_at: now };
      case "reactivate":
        return { ...d, active: 1, deactivated_at: null };
      case "revoke":
        return { ...d, active: 0, revoked_at: now };
    }
  });
}

/** Rename a device's label (optimistic + invalidate). */
export function useRenameDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { deviceId: string; label: string }) =>
      renameDeviceAction(vars.deviceId, vars.label),
    onMutate: async ({ deviceId, label }) => {
      await qc.cancelQueries({ queryKey: devicesQueryKey });
      const prev = qc.getQueryData<DevicesList>(devicesQueryKey);
      qc.setQueryData<DevicesList>(devicesQueryKey, (old) =>
        old ? applyDeviceOptimisticUpdate(old, deviceId, { kind: "rename", label }, new Date().toISOString()) : old,
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(devicesQueryKey, ctx.prev);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: devicesQueryKey });
    },
  });
}

/** Soft-deactivate a device (optimistic + invalidate). */
export function useDeactivateDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => deactivateDeviceAction(deviceId),
    onMutate: async (deviceId) => {
      await qc.cancelQueries({ queryKey: devicesQueryKey });
      const prev = qc.getQueryData<DevicesList>(devicesQueryKey);
      qc.setQueryData<DevicesList>(devicesQueryKey, (old) =>
        old ? applyDeviceOptimisticUpdate(old, deviceId, { kind: "deactivate" }, new Date().toISOString()) : old,
      );
      return { prev };
    },
    onError: (_err, _deviceId, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(devicesQueryKey, ctx.prev);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: devicesQueryKey });
    },
  });
}

/** Reactivate a soft-deactivated device (optimistic + invalidate). */
export function useReactivateDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => reactivateDeviceAction(deviceId),
    onMutate: async (deviceId) => {
      await qc.cancelQueries({ queryKey: devicesQueryKey });
      const prev = qc.getQueryData<DevicesList>(devicesQueryKey);
      qc.setQueryData<DevicesList>(devicesQueryKey, (old) =>
        old ? applyDeviceOptimisticUpdate(old, deviceId, { kind: "reactivate" }, new Date().toISOString()) : old,
      );
      return { prev };
    },
    onError: (_err, _deviceId, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(devicesQueryKey, ctx.prev);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: devicesQueryKey });
    },
  });
}

/** Revoke a (lost) device (optimistic + invalidate). */
export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => revokeDeviceAction(deviceId),
    onMutate: async (deviceId) => {
      await qc.cancelQueries({ queryKey: devicesQueryKey });
      const prev = qc.getQueryData<DevicesList>(devicesQueryKey);
      qc.setQueryData<DevicesList>(devicesQueryKey, (old) =>
        old ? applyDeviceOptimisticUpdate(old, deviceId, { kind: "revoke" }, new Date().toISOString()) : old,
      );
      return { prev };
    },
    onError: (_err, _deviceId, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(devicesQueryKey, ctx.prev);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: devicesQueryKey });
    },
  });
}
