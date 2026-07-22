import { findTag, getBolDoc } from "@rfid/domain";
import { notFound } from "next/navigation";

import { Header } from "@/components/Header";
import { getDb } from "@/lib/db";

/** Public QR-code landing page (`/tag/{epc}`): box details + a link to its BOL
 * document. Printed labels carry this URL, so it must not require sign-in. The
 * "View bill of lading" link renders only when the doc row has a `storage_url`. */
export default async function TagPage({ params }: { params: Promise<{ epc: string }> }) {
  const { epc } = await params;
  const db = await getDb();
  const tag = await findTag(db, epc);
  if (!tag) notFound();
  const doc = tag.bol_doc_id ? await getBolDoc(db, tag.bol_doc_id) : null;
  return (
    <>
      <Header />
      <main className="container">
        <h1>Box {tag.epc}</h1>
        <table className="tag-table">
          <tbody>
            <tr><th>Item type</th><td>{tag.item_type}</td></tr>
            {tag.item_name ? <tr><th>Component</th><td>{tag.item_name}</td></tr> : null}
            <tr><th>BOL</th><td>{tag.bol_number || "—"}</td></tr>
            {tag.po_number ? <tr><th>PO</th><td>{tag.po_number}</td></tr> : null}
            <tr><th>Building</th><td>{tag.building || "—"}</td></tr>
            <tr><th>Vendor</th><td>{tag.vendor || "—"}</td></tr>
            {tag.sku ? <tr><th>Item No.</th><td>{tag.sku}</td></tr> : null}
            <tr><th>Quantity</th><td>{tag.quantity}</td></tr>
            <tr><th>Remaining</th><td>{tag.remaining}</td></tr>
            <tr><th>Status</th><td>{tag.status}</td></tr>
            <tr><th>Received</th><td>{tag.received_at || "—"}</td></tr>
          </tbody>
        </table>
        {doc && doc.storage_url ? (
          <p>
            <a href={doc.storage_url} className="bol-link">View bill of lading ({doc.bol_number || doc.filename})</a>
          </p>
        ) : null}
      </main>
    </>
  );
}
