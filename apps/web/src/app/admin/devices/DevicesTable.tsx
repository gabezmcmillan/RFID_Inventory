"use client";

/**
 * Client-side registry table for the admin Devices page (plan 010, operator
 * scope addition). Renders one row per device with an editable display name,
 * the linker's identity ("Linked by", not "Owner"), last-seen/last-sync, an
 * active/inactive badge, and the lifecycle actions (rename, deactivate /
 * reactivate, revoke). Actions call the server actions in
 * {@link ./actions} then refresh the route so the server component re-reads
 * the registry.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  deactivateDeviceAction,
  reactivateDeviceAction,
  renameDeviceAction,
  revokeDeviceAction,
} from "./actions";
import type { DeviceWithLinker } from "@/lib/devices";

/** Format an ISO timestamp for display, or "—" when null. */
function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/** A status badge for a device's lifecycle state (matches the status palette). */
function statusBadge(d: DeviceWithLinker): { label: string; className: string } {
  const base = "border bg-transparent";
  if (d.active === 1) {
    return { label: "Active", className: `${base} border-status-in/40 text-status-in bg-status-in/10` };
  }
  if (d.revoked_at) {
    return { label: "Revoked", className: `${base} border-destructive/40 text-destructive bg-destructive/10` };
  }
  if (d.unlinked_at) {
    return { label: "Unlinked", className: `${base} border-border text-muted-foreground` };
  }
  if (d.deactivated_at) {
    return { label: "Deactivated", className: `${base} border-status-partial/40 text-status-partial bg-status-partial/10` };
  }
  return { label: "Inactive", className: `${base} border-border text-muted-foreground` };
}

export function DevicesTable({ devices }: { devices: DeviceWithLinker[] }): React.ReactNode {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const refresh = (): void => startTransition(() => router.refresh());

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Device</TableHead>
          <TableHead>Linked by</TableHead>
          <TableHead>Last seen</TableHead>
          <TableHead>Last sync</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {devices.map((d) => (
          <DeviceRow key={d.id} d={d} disabled={pending} onAfter={refresh} />
        ))}
      </TableBody>
    </Table>
  );
}

function DeviceRow({
  d,
  disabled,
  onAfter,
}: {
  d: DeviceWithLinker;
  disabled: boolean;
  onAfter: () => void;
}): React.ReactNode {
  const [label, setLabel] = useState(d.label ?? "");
  const [busy, startBusy] = useTransition();
  const chip = statusBadge(d);

  const run = (fn: () => Promise<unknown>): void => {
    startBusy(async () => {
      await fn();
      onAfter();
    });
  };

  return (
    <tr>
      <TableCell className="py-2 align-middle">
        <div className="flex flex-col gap-1">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Display name"
            className="h-8 max-w-[14rem]"
          />
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{d.epc_byte}</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled || busy || label.trim() === (d.label ?? "")}
              onClick={() => run(() => renameDeviceAction(d.id, label))}
            >
              Save
            </Button>
          </div>
        </div>
      </TableCell>
      <TableCell className="py-2 align-middle">
        <div className="text-sm">{d.linked_by_name ?? "—"}</div>
        <div className="text-xs text-muted-foreground">{d.linked_by_email ?? "unknown"}</div>
        <div className="text-xs text-muted-foreground">{fmt(d.created_at)}</div>
      </TableCell>
      <TableCell className="py-2 align-middle text-sm">{fmt(d.last_seen_at)}</TableCell>
      <TableCell className="py-2 align-middle text-sm">{fmt(d.last_sync_at)}</TableCell>
      <TableCell className="py-2 align-middle">
        <Badge variant="outline" className={chip.className}>
          {chip.label}
        </Badge>
      </TableCell>
      <TableCell className="py-2 align-middle">
        <div className="flex flex-wrap gap-1.5">
          {d.active === 1 ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled || busy}
              onClick={() => run(() => deactivateDeviceAction(d.id))}
            >
              Deactivate
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled || busy || d.revoked_at !== null || d.unlinked_at !== null}
              onClick={() => run(() => reactivateDeviceAction(d.id))}
            >
              Reactivate
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            disabled={disabled || busy || d.revoked_at !== null}
            onClick={() => {
              if (confirm("Revoke this device? Its session is killed and its EPC byte is retired.")) {
                run(() => revokeDeviceAction(d.id));
              }
            }}
          >
            Revoke
          </Button>
        </div>
      </TableCell>
    </tr>
  );
}
