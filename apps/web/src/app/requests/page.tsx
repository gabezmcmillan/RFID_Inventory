import { listOrders, type Order } from "@rfid/domain";

import { Header } from "@/components/Header";
import { EmptyState, PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { orderStateBadge, requestStatusBadge } from "@/lib/status";
import { FocusRefresh } from "./FocusRefresh";

// Auth-gated + reads the warehouse DB at render (`getDb`), so this page is
// inherently request-time. `force-dynamic` stops Next from prerendering it at
// build, which would open the DB on a clean machine. See
// docs/operations/sync-security-decision.md § "Cloud app auth gate".
export const dynamic = "force-dynamic";

function OrderCard({ order }: { order: Order }) {
  const ref = order.order_ref || "";
  const state = orderStateBadge(order.open);
  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle>{ref ? `Order ${ref}` : `Request #${order.lines[0]?.id ?? ""}`}</CardTitle>
        <CardAction>
          <Badge variant="outline" className={state.className}>
            {state.label}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap gap-2 text-sm text-muted-foreground">
          <span>{order.requester || "—"}</span>
          {order.contact ? <span>· {order.contact}</span> : null}
          {order.jobsite ? <span>· {order.jobsite}</span> : null}
          {order.building ? <span>· to Building {order.building}</span> : null}
          {order.created_at ? <span>· {order.created_at}</span> : null}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Qty</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {order.lines.map((l) => {
              const chip = requestStatusBadge(l.status);
              const label = l.item_name ? `${l.item_type} | ${l.item_name}` : l.item_type;
              return (
                <tr key={l.id}>
                  <TableCell className="py-2 align-middle">{label}</TableCell>
                  <TableCell className="py-2 align-middle">{l.quantity}</TableCell>
                  <TableCell className="py-2 align-middle">
                    Building {l.building || "—"}
                  </TableCell>
                  <TableCell className="py-2 align-middle">
                    <Badge variant="outline" className={chip.className}>
                      {chip.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-2 align-middle">{l.handler_note || ""}</TableCell>
                </tr>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Order-status page: requests grouped by order_ref, open orders first. */
export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string }>;
}) {
  const { ok } = await searchParams;
  const db = await getDb();
  const orders = await listOrders(db);
  return (
    <>
      <Header active="requests" />
      <main className="mx-auto w-full max-w-5xl px-5 pb-16 pt-8">
        <PageHeader title="Requests" description="Stock pulls grouped by order, open orders first." />
        <FocusRefresh />
        {ok ? (
          <p className="mb-4 font-semibold text-status-in">Order {ok} submitted.</p>
        ) : null}
        {orders.length === 0 ? (
          <EmptyState
            title="No requests yet"
            description="Build a cart on the Stock page to submit your first request."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {orders.map((o) => (
              <OrderCard key={o.order_ref || `request-${o.lines[0]?.id ?? 0}`} order={o} />
            ))}
          </div>
        )}
      </main>
    </>
  );
}
