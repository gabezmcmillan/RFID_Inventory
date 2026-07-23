import { buildings, stockRows } from "@rfid/domain";

import { Header } from "@/components/Header";
import { PageHeader } from "@/components/PageHeader";
import { getDb } from "@/lib/db";
import { getUser } from "@/lib/session";
import { Cart } from "./cart/Cart";

// Auth-gated + reads the warehouse DB at render (`getDb`), so this page is
// inherently request-time. `force-dynamic` stops Next from prerendering it at
// build, which would open the DB on a clean machine. See
// docs/operations/sync-security-decision.md § "Cloud app auth gate".
export const dynamic = "force-dynamic";

/** Jobsite stock browse + cart. Server fetches the stock rows and delivery
 * buildings; the client `<Cart>` handles cart state and submits via the
 * `submitCart` server action. */
export default async function Home() {
  const db = await getDb();
  const [stock, buildingList] = await Promise.all([stockRows(db), buildings(db)]);
  const user = await getUser();
  return (
    <>
      <Header active="stock" />
      <main className="mx-auto w-full max-w-5xl px-5 pb-16 pt-8">
        <PageHeader
          title="Stock &amp; requests"
          description="Browse what's on hand and build a request to pull stock to a jobsite."
        />
        <Cart stock={stock} buildings={buildingList} user={user} />
      </main>
    </>
  );
}
