"use client";

import { useRouter } from "next/navigation";
import { useTransition, useState } from "react";

import type { CartLineError, StockRow } from "@rfid/domain";

import type { SessionUser } from "@/lib/session";
import { submitCart, type CartSubmission } from "./actions";

/** One editable cart line (a stock selection with quantity + delivery building). */
interface CartLine {
  key: string;
  itemType: string;
  itemName: string;
  stockBuilding: string;
  label: string;
  quantity: string;
  deliveryBuilding: string;
}

/** Client-side cart + checkout. Server passes the stock rows; the user adds
 * lines, sets per-line quantity + delivery building, and submits. Per-line
 * `{line, message}` errors from the server render against the offending line. */
export function Cart({
  stock,
  buildings,
  user,
}: {
  stock: StockRow[];
  buildings: string[];
  user: SessionUser | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [lines, setLines] = useState<CartLine[]>([]);
  const [errors, setErrors] = useState<CartLineError[]>([]);
  const [requester, setRequester] = useState(user?.name ?? "");
  const [contact, setContact] = useState(user?.email ?? "");
  const [jobsite, setJobsite] = useState("");
  const [note, setNote] = useState("");
  const [topError, setTopError] = useState("");

  function addLine(l: Omit<CartLine, "key" | "quantity" | "deliveryBuilding">) {
    setErrors([]);
    setTopError("");
    setLines((prev) => [
      ...prev,
      { ...l, key: crypto.randomUUID(), quantity: "1", deliveryBuilding: "" },
    ]);
  }

  function updateLine(key: string, patch: Partial<CartLine>) {
    setErrors([]);
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: string) {
    setErrors([]);
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setTopError("");
    startTransition(async () => {
      const input: CartSubmission = {
        requester,
        contact,
        jobsite,
        note,
        deliveryBuilding: "",
        lines: lines.map((l) => ({
          item_type: l.itemType,
          item_name: l.itemName,
          building: l.stockBuilding,
          quantity: l.quantity,
          delivery_building: l.deliveryBuilding,
        })),
      };
      const res = await submitCart(input);
      if (res.ok) {
        router.push("/requests?ok=" + res.order_ref);
        return;
      }
      setErrors(res.errors);
      setTopError(res.message);
    });
  }

  return (
    <div className="cart-layout">
      <section className="stock-section">
        <h2>Stock on hand</h2>
        {stock.length === 0 ? (
          <p className="muted">No stock available right now.</p>
        ) : (
          <ul className="stock-list">
            {stock.map((row) =>
              row.named ? (
                <li key={"n-" + row.item_type} className="stock-card">
                  <div className="stock-card-head">
                    <span className="stock-type">{row.item_type}</span>
                    <span className="muted">named type</span>
                    <span className="stock-units">{row.units} units / {row.boxes} boxes</span>
                  </div>
                  <ul className="component-list">
                    {row.components.map((c) => (
                      <li key={"c-" + row.item_type + "-" + c.item_name + "-" + c.building}>
                        <div className="component-row">
                          <span className="component-name">{c.item_name}</span>
                          <span className="muted">Building {c.building || "—"}</span>
                          <span>{c.units}/{c.capacity} units · {c.status}</span>
                          <span className="muted">{c.boxes} boxes</span>
                          <button
                            type="button"
                            className="add-btn"
                            onClick={() =>
                              addLine({
                                itemType: row.item_type,
                                itemName: c.item_name,
                                stockBuilding: c.building,
                                label: `${row.item_type} | ${c.item_name} (Bldg ${c.building || "—"})`,
                              })
                            }
                          >
                            Add
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              ) : (
                <li key={"p-" + row.item_type + "-" + row.building} className="stock-card">
                  <div className="stock-card-head">
                    <span className="stock-type">{row.item_type}</span>
                    <span className="muted">Building {row.building || "—"}</span>
                    <span className="stock-units">{row.units} units / {row.boxes} boxes</span>
                    <button
                      type="button"
                      className="add-btn"
                      onClick={() =>
                        addLine({
                          itemType: row.item_type,
                          itemName: "",
                          stockBuilding: row.building,
                          label: `${row.item_type} (Bldg ${row.building || "—"})`,
                        })
                      }
                    >
                      Add
                    </button>
                  </div>
                  <details>
                    <summary className="muted">BOL breakdown ({row.groups.length})</summary>
                    <table className="mini-table">
                      <thead>
                        <tr><th>BOL</th><th>Vendor</th><th>Units</th><th>Boxes</th><th>First received</th></tr>
                      </thead>
                      <tbody>
                        {row.groups.map((g, i) => (
                          <tr key={i}>
                            <td>{g.bol_number || "—"}</td>
                            <td>{g.vendor || "—"}</td>
                            <td>{g.units}</td>
                            <td>{g.boxes}</td>
                            <td>{g.first_received || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      <aside className="cart-section">
        <h2>Cart ({lines.length})</h2>
        {topError ? <p className="error">{topError}</p> : null}
        {lines.length === 0 ? (
          <p className="muted">Add stock to your cart.</p>
        ) : (
          <ul className="cart-list">
            {lines.map((l, idx) => {
              const err = errors.find((e) => e.line === idx)?.message;
              return (
                <li key={l.key} className={err ? "cart-line has-error" : "cart-line"}>
                  <div className="cart-line-label">{l.label}</div>
                  <div className="cart-line-controls">
                    <label>
                      Qty
                      <input
                        type="number"
                        min={1}
                        value={l.quantity}
                        onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                      />
                    </label>
                    <label>
                      Deliver to
                      <select
                        value={l.deliveryBuilding}
                        onChange={(e) => updateLine(l.key, { deliveryBuilding: e.target.value })}
                      >
                        <option value="">—</option>
                        {buildings.map((b) => (
                          <option key={b} value={b}>Building {b}</option>
                        ))}
                      </select>
                    </label>
                    <button type="button" className="remove-btn" onClick={() => removeLine(l.key)}>
                      Remove
                    </button>
                  </div>
                  {err ? <p className="error line-error">{err}</p> : null}
                </li>
              );
            })}
          </ul>
        )}

        <form className="checkout-form" onSubmit={onSubmit}>
          <h3>Checkout</h3>
          <label>
            Your name
            <input value={requester} onChange={(e) => setRequester(e.target.value)} required />
          </label>
          <label>
            Contact
            <input value={contact} onChange={(e) => setContact(e.target.value)} />
          </label>
          <label>
            Jobsite
            <input value={jobsite} onChange={(e) => setJobsite(e.target.value)} />
          </label>
          <label>
            Note
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </label>
          <button type="submit" disabled={pending || lines.length === 0}>
            {pending ? "Submitting…" : "Submit request"}
          </button>
        </form>
      </aside>
    </div>
  );
}
