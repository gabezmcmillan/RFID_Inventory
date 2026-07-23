import { findTag, getBolDoc } from "@rfid/domain";
import { notFound } from "next/navigation";

import { Header } from "@/components/Header";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import { issueBolGetUrl } from "@/lib/bolBlob";
import { getDb } from "@/lib/db";
import { inventoryStatusBadge } from "@/lib/status";

/** QR-code landing page (`/tag/{epc}`): box details + a link to its BOL document.
 * Printed labels carry this URL. Per the 2026-07-23 operator decision the whole
 * cloud app requires login, so this page is now behind the auth gate
 * (`src/proxy.ts`) — a label QR requires sign-in on first scan (warehouse staff
 * all have Entra accounts). See the decision doc § "Cloud app auth gate".
 *
 * The "View bill of lading" link renders only when the doc row has a
 * `storage_url`; the `rfid-bol` Blob store is private, so the link is a
 * short-lived presigned GET URL minted on render (no read-write token in the
 * page). */
export default async function TagPage({ params }: { params: Promise<{ epc: string }> }) {
  const { epc } = await params;
  const db = await getDb();
  const tag = await findTag(db, epc);
  if (!tag) notFound();
  const doc = tag.bol_doc_id ? await getBolDoc(db, tag.bol_doc_id) : null;
  const bolUrl = doc?.storage_url ? await issueBolGetUrl(doc.storage_url) : null;
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
      <main className="mx-auto w-full max-w-5xl px-5 pb-16 pt-8">
        <PageHeader title={`Box ${tag.epc}`} description="Scanned from a printed label." />
        <Card className="max-w-xl">
          <CardContent className="pt-6">
            <Table>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.label}>
                    <TableCell className="w-40 text-muted-foreground">{r.label}</TableCell>
                    <TableCell className="font-medium">{r.value}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {bolUrl ? (
              <Button variant="link" className="mt-4 h-auto p-0" render={<a href={bolUrl} />}>
                View bill of lading ({doc!.bol_number || doc!.filename})
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
