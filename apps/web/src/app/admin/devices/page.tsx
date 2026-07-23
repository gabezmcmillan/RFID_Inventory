/**
 * Admin Devices page (plan 010, operator scope addition). Lists the
 * field-device registry with an editable display name, the linker's identity
 * ("Linked by", not "Owner"), last-seen/last-sync, and the lifecycle actions.
 *
 * Server Component: prefetches the registry into a per-request `QueryClient`
 * and dehydrates it into a `<HydrationBoundary>`. The {@link DevicesTable}
 * client component owns the list display (count, empty / loading / error
 * states) and the mutations — it reads the prefetched data instantly and
 * refetches via `GET /api/admin/devices` on invalidation / focus. This is the
 * canonical TanStack Query v5 + App Router prefetch pattern (see the
 * "Advanced Server Rendering" guide): the server prefetches, the client owns
 * the data, and mutations call the existing Server Actions in `./actions`
 * (no API redesign).
 */

import { dehydrate, HydrationBoundary } from "@tanstack/react-query";

import { Header } from "@/components/Header";
import { PageHeader } from "@/components/PageHeader";
import { listDevicesWithLinker } from "@/lib/devices";
import { getQueryClient } from "@/lib/query/get-query-client";

import { DevicesTable } from "./DevicesTable";
import { devicesQueryKey } from "./queries";

// Auth-gated + reads the auth DB at render (`listDevicesWithLinker`), so this
// page is inherently request-time. `force-dynamic` stops Next from prerendering
// it at build, which would open `.dev-data/auth.db` on a clean machine (CI has
// no `.env.local`, so `getUser()` returns null without calling `headers()` and
// the page would otherwise be statically prerendered → CANTOPEN). See
// docs/operations/sync-security-decision.md § "Cloud app auth gate".
export const dynamic = "force-dynamic";

export default async function AdminDevicesPage(): Promise<React.ReactNode> {
  const queryClient = getQueryClient();
  // Prefetch the registry directly from the server DB (no client fetch on first
  // paint). `prefetchQuery` is awaited so the dehydrated state is ready.
  await queryClient.prefetchQuery({
    queryKey: devicesQueryKey,
    queryFn: () => listDevicesWithLinker(),
  });

  return (
    <>
      <Header active="devices" />
      <main className="mx-auto w-full max-w-5xl px-5 pb-16 pt-8">
        <PageHeader
          title="Field devices"
          description="The person who links a device via QR is setting it up — they are not necessarily the person using it day-to-day. “Linked by” names that operator, not an owner."
        />
        <HydrationBoundary state={dehydrate(queryClient)}>
          <DevicesTable />
        </HydrationBoundary>
      </main>
    </>
  );
}
