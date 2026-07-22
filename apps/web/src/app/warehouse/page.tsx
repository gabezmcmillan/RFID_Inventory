import { BUILDING_OPTIONS, inventoryTree, type InventoryType } from "@rfid/domain";

import { Header } from "@/components/Header";
import { getDb } from "@/lib/db";

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

  const toggle = (label: string, key: string, active: boolean) => (
    <a href={key} aria-current={active ? "page" : undefined} className="nav-link">
      {label}
    </a>
  );

  return (
    <>
      <Header active="warehouse" />
      <main className="container">
        <h1>Warehouse (office view)</h1>
        <div className="warehouse-controls">
          <span className="muted">Group by:</span>
          {toggle("BOL", "/warehouse?group=bol" + (building ? `&building=${building}` : ""), groupBy === "bol")}
          {toggle("Building", "/warehouse?group=building" + (building ? `&building=${building}` : ""), groupBy === "building")}
          <span className="muted">·</span>
          <a href="/warehouse" aria-current={!building ? "page" : undefined} className="nav-link">All buildings</a>
          {BUILDING_OPTIONS.map((b) => (
            <a
              key={b}
              href={`/warehouse?group=${groupBy}&building=${b}`}
              aria-current={building === b ? "page" : undefined}
              className="nav-link"
            >
              Bldg {b}
            </a>
          ))}
        </div>
        {tree.types.length === 0 ? (
          <p className="muted">No boxes match.</p>
        ) : (
          <ul className="warehouse-list">
            {tree.types.map((t: InventoryType) => (
              <li key={t.item_type} className="stock-card">
                <div className="stock-card-head">
                  <span className="stock-type">{t.item_type}</span>
                  <span className="muted">{t.named ? "named" : "plain"}</span>
                  <span className="stock-units">{t.qty} units</span>
                </div>
                <table className="mini-table">
                  <thead>
                    <tr><th>{t.named ? "Component" : tree.group_by === "bol" ? "BOL" : "Building"}</th><th>In wh</th><th>Capacity</th><th>Boxes</th><th>Status</th><th>First received</th></tr>
                  </thead>
                  <tbody>
                    {t.groups.map((g) => (
                      <tr key={g.value}>
                        <td>{g.value || "—"}</td>
                        <td>{g.in_wh}</td>
                        <td>{g.capacity}</td>
                        <td>{g.boxes}</td>
                        <td>{g.status}</td>
                        <td>{g.received || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
