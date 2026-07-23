"use client";

import { useRouter } from "next/navigation";
import { useTransition, useState } from "react";

import type { CartLineError, StockRow } from "@rfid/domain";

import type { SessionUser } from "@/lib/session";
import { inventoryStatusBadge } from "@/lib/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/PageHeader";
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
    <div className="grid grid-cols-[1fr_360px] items-start gap-6 max-md:grid-cols-1">
      <section>
        <h2 className="mb-3 text-lg font-semibold">Stock on hand</h2>
        {stock.length === 0 ? (
          <EmptyState
            title="No stock available right now"
            description="Check back after the next receiving run, or filter by building on the Warehouse page."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {stock.map((row) =>
              row.named ? (
                <li key={"n-" + row.item_type}>
                  <Card>
                    <CardHeader>
                      <CardTitle>{row.item_type}</CardTitle>
                      <CardAction>
                        <span className="text-sm text-muted-foreground">
                          {row.units} units / {row.boxes} boxes
                        </span>
                      </CardAction>
                    </CardHeader>
                    <CardContent>
                      <Badge variant="outline" className="mb-3 border-border text-muted-foreground">
                        named type
                      </Badge>
                      <ul className="flex flex-col gap-2">
                        {row.components.map((c) => {
                          const chip = inventoryStatusBadge(c.status);
                          return (
                            <li
                              key={"c-" + row.item_type + "-" + c.item_name + "-" + c.building}
                              className="flex flex-wrap items-center gap-3 text-sm"
                            >
                              <span className="min-w-32 font-semibold">{c.item_name}</span>
                              <span className="text-muted-foreground">
                                Building {c.building || "—"}
                              </span>
                              <span>
                                {c.units}/{c.capacity} units · {c.status}
                              </span>
                              <span className="text-muted-foreground">{c.boxes} boxes</span>
                              <Badge variant="outline" className={chip.className}>
                                {chip.label}
                              </Badge>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="ml-auto"
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
                              </Button>
                            </li>
                          );
                        })}
                      </ul>
                    </CardContent>
                  </Card>
                </li>
              ) : (
                <li key={"p-" + row.item_type + "-" + row.building}>
                  <Card>
                    <CardHeader>
                      <CardTitle>{row.item_type}</CardTitle>
                      <CardAction>
                        <span className="text-sm text-muted-foreground">
                          {row.units} units / {row.boxes} boxes
                        </span>
                      </CardAction>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-sm text-muted-foreground">
                          Building {row.building || "—"}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="ml-auto"
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
                        </Button>
                      </div>
                      <details className="mt-3">
                        <summary className="cursor-pointer text-sm text-muted-foreground">
                          BOL breakdown ({row.groups.length})
                        </summary>
                        <Table className="mt-2">
                          <TableHeader>
                            <TableRow>
                              <TableHead>BOL</TableHead>
                              <TableHead>Vendor</TableHead>
                              <TableHead>Units</TableHead>
                              <TableHead>Boxes</TableHead>
                              <TableHead>First received</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {row.groups.map((g, i) => (
                              <TableRow key={i}>
                                <TableCell>{g.bol_number || "—"}</TableCell>
                                <TableCell>{g.vendor || "—"}</TableCell>
                                <TableCell>{g.units}</TableCell>
                                <TableCell>{g.boxes}</TableCell>
                                <TableCell>{g.first_received || "—"}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </details>
                    </CardContent>
                  </Card>
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      <aside>
        <Card className="sticky top-4">
          <CardHeader>
            <CardTitle>Cart ({lines.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {topError ? <p className="mb-3 text-sm text-destructive">{topError}</p> : null}
            {lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add stock to your cart.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {lines.map((l, idx) => {
                  const err = errors.find((e) => e.line === idx)?.message;
                  return (
                    <li
                      key={l.key}
                      className={
                        "rounded-lg border p-2.5" + (err ? " border-destructive" : " border-border")
                      }
                    >
                      <div className="text-sm font-semibold">{l.label}</div>
                      <div className="mt-2 flex flex-wrap items-end gap-3 text-sm">
                        <div className="flex flex-col gap-1">
                          <Label className="text-xs text-muted-foreground">Qty</Label>
                          <Input
                            type="number"
                            min={1}
                            value={l.quantity}
                            onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                            className="w-20"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <Label className="text-xs text-muted-foreground">Deliver to</Label>
                          <Select
                            value={l.deliveryBuilding}
                            onValueChange={(v) =>
                              updateLine(l.key, { deliveryBuilding: (v ?? "") as string })
                            }
                          >
                            <SelectTrigger className="w-40">
                              <SelectValue placeholder="—" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="">—</SelectItem>
                              {buildings.map((b) => (
                                <SelectItem key={b} value={b}>
                                  Building {b}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeLine(l.key)}
                        >
                          Remove
                        </Button>
                      </div>
                      {err ? <p className="mt-2 text-sm text-destructive">{err}</p> : null}
                    </li>
                  );
                })}
              </ul>
            )}

            <Separator className="my-4" />
            <form className="flex flex-col gap-2.5" onSubmit={onSubmit}>
              <h3 className="text-sm font-semibold">Checkout</h3>
              <div className="flex flex-col gap-1">
                <Label htmlFor="requester" className="text-xs text-muted-foreground">
                  Your name
                </Label>
                <Input
                  id="requester"
                  value={requester}
                  onChange={(e) => setRequester(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="contact" className="text-xs text-muted-foreground">
                  Contact
                </Label>
                <Input
                  id="contact"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="jobsite" className="text-xs text-muted-foreground">
                  Jobsite
                </Label>
                <Input
                  id="jobsite"
                  value={jobsite}
                  onChange={(e) => setJobsite(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="note" className="text-xs text-muted-foreground">
                  Note
                </Label>
                <Textarea
                  id="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                />
              </div>
              <Button type="submit" disabled={pending || lines.length === 0} className="mt-1">
                {pending ? "Submitting…" : "Submit request"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
