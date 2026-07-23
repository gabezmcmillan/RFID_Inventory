import { counts, lastUpdated } from "@rfid/domain";

import { UserMenu } from "@/components/UserMenu";
import { getDb } from "@/lib/db";
import { getUser } from "@/lib/session";

/** Shared site header: nav + header counts (warehouse units, open requests) + last updated,
 * plus the signed-in user's name/email and a sign-out affordance. */
export async function Header({ active }: { active?: "stock" | "requests" | "warehouse" }) {
  let units = 0;
  let pending = 0;
  let updated = "";
  // Independent reads — run in parallel rather than as a waterfall
  // (`async-parallel`). `getUser` is resolved alongside the header counts so the
  // header and the principal arrive together.
  const userPromise = getUser();
  try {
    const db = await getDb();
    const [c, last] = await Promise.all([counts(db), lastUpdated(db)]);
    units = c.units;
    pending = c.requests_pending;
    updated = last;
  } catch {
    // A cold start before the DB is ready: render the header without numbers
    // rather than 500-ing the whole page.
  }
  const user = await userPromise;
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
        {user ? <UserMenu name={user.name} email={user.email} /> : null}
      </div>
      <div className="site-header-row site-stats">
        <span><strong>{units}</strong> units in warehouse</span>
        <span><strong>{pending}</strong> open request{pending === 1 ? "" : "s"}</span>
        <span className="muted">{updated ? `Last updated ${updated}` : ""}</span>
      </div>
    </header>
  );
}
