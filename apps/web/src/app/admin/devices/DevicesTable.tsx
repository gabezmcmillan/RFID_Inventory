"use client";

/**
 * Client-side registry table for the admin Devices page (plan 010, operator
 * scope addition). Renders one row per device with an editable display name,
 * the linker's identity ("Linked by", not "Owner"), last-seen/last-sync, an
 * active/inactive badge, and the lifecycle actions (rename, deactivate /
 * reactivate, revoke).
 *
 * Data is owned by TanStack Query ({@link useDevicesQuery}); the server page
 * prefetches + dehydrates it so first paint is instant, and refetches (focus,
 * invalidation) hit `GET /api/admin/devices`. Mutations call the Server
 * Actions in `./actions` via the hooks in `./queries` with optimistic updates
 * + invalidation — no more `router.refresh()` dance. The count + empty /
 * loading / error states live here (the client owns the list display).
 */

import { useState } from "react";

import { EmptyState } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DeviceWithLinker } from "@/lib/devices";
import {
  useDeactivateDevice,
  useDevicesQuery,
  useReactivateDevice,
  useRenameDevice,
  useRevokeDevice,
} from "./queries";

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

export function DevicesTable(): React.ReactNode {
  const { data: devices, isPending, isError, error } = useDevicesQuery();

  if (isPending) {
    return (
      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle>Loading devices…</CardTitle>
        </CardHeader>
      </Card>
    );
  }

  if (isError) {
    return (
      <EmptyState
        title="Couldn’t load devices"
        description={error instanceof Error ? error.message : "Try refreshing the page."}
      />
    );
  }

  if (devices.length === 0) {
    return (
      <EmptyState
        title="No devices linked yet"
        description="Link a field device from your user menu to see it here."
      />
    );
  }

  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle>{devices.length} device{devices.length === 1 ? "" : "s"}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
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
              <DeviceRow key={d.id} d={d} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function DeviceRow({ d }: { d: DeviceWithLinker }): React.ReactNode {
  const [label, setLabel] = useState(d.label ?? "");
  const rename = useRenameDevice();
  const deactivate = useDeactivateDevice();
  const reactivate = useReactivateDevice();
  const revoke = useRevokeDevice();
  const chip = statusBadge(d);

  // A mutation is "busy" for this row when any of its own actions is in flight.
  const busy =
    rename.isPending || deactivate.isPending || reactivate.isPending || revoke.isPending;

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
              disabled={busy || label.trim() === (d.label ?? "")}
              onClick={() => rename.mutate({ deviceId: d.id, label })}
            >
              {rename.isPending ? "Saving…" : "Save"}
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
              disabled={busy}
              onClick={() => deactivate.mutate(d.id)}
            >
              {deactivate.isPending ? "…" : "Deactivate"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || d.revoked_at !== null || d.unlinked_at !== null}
              onClick={() => reactivate.mutate(d.id)}
            >
              {reactivate.isPending ? "…" : "Reactivate"}
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || d.revoked_at !== null}
            onClick={() => {
              if (confirm("Revoke this device? Its session is killed and its EPC byte is retired.")) {
                revoke.mutate(d.id);
              }
            }}
          >
            {revoke.isPending ? "…" : "Revoke"}
          </Button>
        </div>
      </TableCell>
    </tr>
  );
}
