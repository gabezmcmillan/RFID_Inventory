import { BUILDING_OPTIONS, inventoryTree, type InventoryType } from "@rfid/domain";

import { Header } from "@/components/Header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { inventoryStatusBadge } from "@/lib/status";
import { cn } from "@/lib/utils";

/** Office warehouse view: read-only reuse of the domain `inventoryTree`, with the
 * same group-by toggle + building filter as the field app's warehouse screen.
 * Toggles are links with query params (server re-renders); no client fetching. */
export default async function WarehousePage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string; building?: string }>;
}) {
  const { group, building } = await searchParams;
  const groupBy = group === "building" ? "building" : "bol";
  const filters = building ? { building } : null;
  const db = await getDb();
  const tree = await inventoryTree(db, groupBy, filters);

  const toggle = (key: string, label: string, href: string, active: boolean) => (
    <a
      key={key}
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(buttonVariants({ variant: active ? "default" : "outline", size: "sm" }))}
    >
      {label}
    </a>
  );

  return (
    <>
      <Header active="warehouse" />
      <main className="mx-auto w-full max-w-5xl px-5 pb-16">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Warehouse (office view)</h1>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Group by:</span>
          {toggle("bol", "BOL",
            "/warehouse?group=bol" + (building ? `&building=${building}` : ""),
            groupBy === "bol",
          )}
          {toggle("building", "Building",
            "/warehouse?group=building" + (building ? `&building=${building}` : ""),
            groupBy === "building",
          )}
          <Separator orientation="vertical" className="mx-1 h-6" />
          {toggle("all", "All buildings", "/warehouse", !building)}
          {BUILDING_OPTIONS.map((b) =>
            toggle(
              b,
              `Bldg ${b}`,
              `/warehouse?group=${groupBy}&building=${b}`,
              building === b,
            ),
          )}
        </div>
        {tree.types.length === 0 ? (
          <p className="text-sm text-muted-foreground">No boxes match.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {tree.types.map((t: InventoryType) => (
              <li key={t.item_type}>
                <Card>
                  <CardHeader>
                    <CardTitle>{t.item_type}</CardTitle>
                    <CardAction>
                      <Badge variant="outline" className="border-border text-muted-foreground">
                        {t.named ? "named" : "plain"}
                      </Badge>
                      <span className="ml-2 text-sm text-muted-foreground">{t.qty} units</span>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>
                            {t.named ? "Component" : tree.group_by === "bol" ? "BOL" : "Building"}
                          </TableHead>
                          <TableHead>In wh</TableHead>
                          <TableHead>Capacity</TableHead>
                          <TableHead>Boxes</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>First received</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {t.groups.map((g) => {
                          const chip = inventoryStatusBadge(g.status);
                          return (
                            <TableRow key={g.value}>
                              <TableCell>{g.value || "—"}</TableCell>
                              <TableCell>{g.in_wh}</TableCell>
                              <TableCell>{g.capacity}</TableCell>
                              <TableCell>{g.boxes}</TableCell>
                              <TableCell>
                                <Badge variant="outline" className={chip.className}>
                                  {chip.label}
                                </Badge>
                              </TableCell>
                              <TableCell>{g.received || "—"}</TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
