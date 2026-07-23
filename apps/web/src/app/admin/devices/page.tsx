/**
 * Admin Devices page (plan 010, operator scope addition). Lists the
 * field-device registry with an editable display name, the linker's identity
 * ("Linked by", not "Owner"), last-seen/last-sync, and the lifecycle actions.
 * Server component: reads the registry directly; the {@link DevicesTable}
 * client component drives the mutations and refreshes.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Header } from "@/components/Header";
import { listDevicesWithLinker } from "@/lib/devices";

import { DevicesTable } from "./DevicesTable";

export default async function AdminDevicesPage(): Promise<React.ReactNode> {
  const devices = await listDevicesWithLinker();
  return (
    <>
      <Header active="devices" />
      <main className="mx-auto w-full max-w-5xl px-5 pb-16">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Field devices</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          The person who links a device via QR is setting it up — they are not necessarily the person
          using it day-to-day. &ldquo;Linked by&rdquo; names that operator, not an owner.
        </p>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No devices linked yet.</p>
        ) : (
          <Card>
            <CardHeader className="border-b border-border">
              <CardTitle>{devices.length} device{devices.length === 1 ? "" : "s"}</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <DevicesTable devices={devices} />
            </CardContent>
          </Card>
        )}
      </main>
    </>
  );
}
