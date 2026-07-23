import { counts, lastUpdated } from "@rfid/domain";

import { UserMenu } from "@/components/UserMenu";
import { getDb } from "@/lib/db";
import { getUser } from "@/lib/session";

/** Shared site header: nav + header counts (warehouse units, open requests) + last updated,
 * plus the signed-in user's name/email and a sign-out affordance. */
export async function Header({ active }: { active?: "stock" | "requests" | "warehouse" | "devices" }) {
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
  const navLink = (href: string, label: string, key: string) => (
    <a
      href={href}
      aria-current={active === key ? "page" : undefined}
      className={
        "text-sm font-medium text-muted-foreground transition-colors hover:text-foreground" +
        (active === key ? " text-foreground underline underline-offset-4" : "")
      }
    >
      {label}
    </a>
  );
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-5 px-5 py-3">
        <a href="/" className="text-base font-bold tracking-tight">
          RFID Inventory
        </a>
        <nav className="flex items-center gap-4">
          {navLink("/", "Stock", "stock")}
          {navLink("/requests", "Requests", "requests")}
          {navLink("/warehouse", "Warehouse", "warehouse")}
          {navLink("/admin/devices", "Devices", "devices")}
        </nav>
        {user ? <UserMenu name={user.name} email={user.email} /> : null}
      </div>
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-6 px-5 pb-2 text-sm text-muted-foreground">
        <span>
          <strong className="text-foreground">{units}</strong> units in warehouse
        </span>
        <span>
          <strong className="text-foreground">{pending}</strong> open request{pending === 1 ? "" : "s"}
        </span>
        <span>{updated ? `Last updated ${updated}` : ""}</span>
      </div>
    </header>
  );
}
