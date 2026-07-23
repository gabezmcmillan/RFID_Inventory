import { findTag, getBolDoc } from "@rfid/domain";
import { notFound } from "next/navigation";

import { Header } from "@/components/Header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { inventoryStatusBadge } from "@/lib/status";

/** Public QR-code landing page (`/tag/{epc}`): box details + a link to its BOL
 * document. Printed labels carry this URL, so it must not require sign-in. The
 * "View bill of lading" link renders only when the doc row has a `storage_url`. */
export default async function TagPage({ params }: { params: Promise<{ epc: string }> }) {
  const { epc } = await params;
  const db = await getDb();
  const tag = await findTag(db, epc);
  if (!tag) notFound();
  const doc = tag.bol_doc_id ? await getBolDoc(db, tag.bol_doc_id) : null;
  const status = inventoryStatusBadge(tag.status);
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Item type", value: tag.item_type },
    ...(tag.item_name ? [{ label: "Component", value: tag.item_name }] : []),
    { label: "BOL", value: tag.bol_number || "—" },
    ...(tag.po_number ? [{ label: "PO", value: tag.po_number }] : []),
    { label: "Building", value: tag.building || "—" },
    { label: "Vendor", value: tag.vendor || "—" },
    ...(tag.sku ? [{ label: "Item No.", value: tag.sku }] : []),
    { label: "Quantity", value: tag.quantity },
    { label: "Remaining", value: tag.remaining },
    { label: "Status", value: <Badge variant="outline" className={status.className}>{status.label}</Badge> },
    { label: "Received", value: tag.received_at || "—" },
  ];
  return (
    <>
      <Header />
      <main className="mx-auto w-full max-w-5xl px-5 pb-16">
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Box {tag.epc}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.label}>
                    <TableCell className="w-36 text-muted-foreground">{r.label}</TableCell>
                    <TableCell>{r.value}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {doc && doc.storage_url ? (
              <Button variant="link" className="mt-4 h-auto p-0" render={<a href={doc.storage_url} />}>
                View bill of lading ({doc.bol_number || doc.filename})
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
