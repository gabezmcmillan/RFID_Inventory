import { counts, lastUpdated } from "@rfid/domain";

import { getDb } from "@/lib/db";

/** Shared site header: nav + header counts (warehouse units, open requests) + last updated. */
export async function Header({ active }: { active?: "stock" | "requests" | "warehouse" }) {
  let units = 0;
  let pending = 0;
  let updated = "";
  try {
    const db = await getDb();
    const c = await counts(db);
    units = c.units;
    pending = c.requests_pending;
    updated = await lastUpdated(db);
  } catch {
    // A cold start before the DB is ready: render the header without numbers
    // rather than 500-ing the whole page.
  }
  const link = (href: string, label: string, key: string) => (
    <a href={href} aria-current={active === key ? "page" : undefined} className="nav-link">
      {label}
    </a>
  );
  return (
    <header className="site-header">
      <div className="site-header-row">
        <a href="/" className="brand">RFID Inventory</a>
        <nav className="site-nav">
          {link("/", "Stock", "stock")}
          {link("/requests", "Requests", "requests")}
          {link("/warehouse", "Warehouse", "warehouse")}
        </nav>
      </div>
      <div className="site-header-row site-stats">
        <span><strong>{units}</strong> units in warehouse</span>
        <span><strong>{pending}</strong> open request{pending === 1 ? "" : "s"}</span>
        <span className="muted">{updated ? `Last updated ${updated}` : ""}</span>
      </div>
    </header>
  );
}
