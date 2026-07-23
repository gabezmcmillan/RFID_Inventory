/**
 * Admin Devices page (plan 010, operator scope addition). Lists the
 * field-device registry with an editable display name, the linker's identity
 * ("Linked by", not "Owner"), last-seen/last-sync, and the lifecycle actions.
 * Server component: reads the registry directly; the {@link DevicesTable}
 * client component drives the mutations and refreshes.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Header } from "@/components/Header";
import { EmptyState, PageHeader } from "@/components/PageHeader";
import { listDevicesWithLinker } from "@/lib/devices";

import { DevicesTable } from "./DevicesTable";

// Auth-gated + reads the auth DB at render (`listDevicesWithLinker`), so this
// page is inherently request-time. `force-dynamic` stops Next from prerendering
// it at build, which would open `.dev-data/auth.db` on a clean machine (CI has
// no `.env.local`, so `getUser()` returns null without calling `headers()` and
// the page would otherwise be statically prerendered → CANTOPEN). See
// docs/operations/sync-security-decision.md § "Cloud app auth gate".
export const dynamic = "force-dynamic";

export default async function AdminDevicesPage(): Promise<React.ReactNode> {
  const devices = await listDevicesWithLinker();
  return (
    <>
      <Header active="devices" />
      <main className="mx-auto w-full max-w-5xl px-5 pb-16 pt-8">
        <PageHeader
          title="Field devices"
          description="The person who links a device via QR is setting it up — they are not necessarily the person using it day-to-day. “Linked by” names that operator, not an owner."
        />
        {devices.length === 0 ? (
          <EmptyState
            title="No devices linked yet"
            description="Link a field device from your user menu to see it here."
          />
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
