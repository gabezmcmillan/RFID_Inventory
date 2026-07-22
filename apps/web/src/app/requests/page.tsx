import { listOrders, type Order } from "@rfid/domain";

import { Header } from "@/components/Header";
import { getDb } from "@/lib/db";
import { FocusRefresh } from "./FocusRefresh";

/** Status chip label + class for a request row. */
function statusChip(status: string): { label: string; className: string } {
  switch (status) {
    case "pending":
      return { label: "Pending", className: "chip chip-pending" };
    case "staging":
      return { label: "Staging", className: "chip chip-staging" };
    case "fulfilled":
      return { label: "Fulfilled", className: "chip chip-fulfilled" };
    case "declined":
      return { label: "Declined", className: "chip chip-declined" };
    default:
      return { label: status, className: "chip" };
  }
}

function OrderCard({ order }: { order: Order }) {
  const ref = order.order_ref || "";
  return (
    <article className="order-card">
      <header className="order-card-head">
        <h3>{ref ? `Order ${ref}` : `Request #${order.lines[0]?.id ?? ""}`}</h3>
        <span className={order.open ? "chip chip-open" : "chip chip-closed"}>
          {order.open ? "Open" : "Closed"}
        </span>
        <span className="muted">{order.created_at || ""}</span>
      </header>
      <div className="order-meta">
        <span>{order.requester || "—"}</span>
        {order.contact ? <span className="muted">· {order.contact}</span> : null}
        {order.jobsite ? <span className="muted">· {order.jobsite}</span> : null}
        {order.building ? <span className="muted">· to Building {order.building}</span> : null}
      </div>
      <table className="order-lines">
        <thead>
          <tr><th>Item</th><th>Qty</th><th>To</th><th>Status</th><th>Note</th></tr>
        </thead>
        <tbody>
          {order.lines.map((l) => {
            const chip = statusChip(l.status);
            const label = l.item_name ? `${l.item_type} | ${l.item_name}` : l.item_type;
            return (
              <tr key={l.id}>
                <td>{label}</td>
                <td>{l.quantity}</td>
                <td>Building {l.building || "—"}</td>
                <td><span className={chip.className}>{chip.label}</span></td>
                <td>{l.handler_note || ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </article>
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
      <main className="container">
        <h1>Requests</h1>
        <FocusRefresh />
        {ok ? <p className="success">Order {ok} submitted.</p> : null}
        {orders.length === 0 ? (
          <p className="muted">No requests yet.</p>
        ) : (
          <div className="order-list">
            {orders.map((o) => (
              <OrderCard key={o.order_ref || `request-${o.lines[0]?.id ?? 0}`} order={o} />
            ))}
          </div>
        )}
      </main>
    </>
  );
}
