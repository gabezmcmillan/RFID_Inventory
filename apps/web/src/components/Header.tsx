import { counts, lastUpdated } from "@rfid/domain";
import Link from "next/link";

import { UserMenu } from "@/components/UserMenu";
import { cn } from "@/lib/utils";
import { getDb } from "@/lib/db";
import { getUser } from "@/lib/session";

/** A nav entry in the branded topbar. Pill-style link; `active` marks the
 * current page with a translucent chip + brighter text. */
function NavLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-full border border-transparent px-3 py-1.5 text-sm font-medium text-white/80 transition-colors hover:border-white/25 hover:text-white",
        active ? "border-white/20 bg-white/15 text-white" : "",
      )}
    >
      {label}
    </Link>
  );
}

/** The signed-in user's name/email, shown when there is no live count yet. */
function CountStat({ value, label }: { value: number | string; label: string }) {
  return (
    <span className="whitespace-nowrap">
      <strong className="font-semibold text-white">{value}</strong>{" "}
      <span className="text-white/70">{label}</span>
    </span>
  );
}

/**
 * Shared site shell: a navy brand topbar (nav + user menu) over a thin counts
 * strip (warehouse units, open requests, last updated). Server component —
 * `getUser()` and the header counts resolve in parallel (`async-parallel`) so
 * the header and the principal arrive together. A cold start before the DB is
 * ready renders the header without numbers rather than 500-ing the page.
 */
export async function Header({
  active,
}: {
  active?: "stock" | "requests" | "warehouse" | "devices";
}) {
  let units = 0;
  let pending = 0;
  let updated = "";
  const userPromise = getUser();
  try {
    const db = await getDb();
    const [c, last] = await Promise.all([counts(db), lastUpdated(db)]);
    units = c.units;
    pending = c.requests_pending;
    updated = last;
  } catch {
    // Cold start before the DB is ready: render the header without numbers.
  }
  const user = await userPromise;
  return (
    <header className="bg-brand-navy text-white shadow-sm dark:bg-brand-navy-dark">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-6 px-5 py-3">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-base font-bold tracking-tight text-white">RFID Inventory</span>
          <span className="hidden text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55 sm:inline">
            Brasfield &amp; Gorrie
          </span>
        </Link>
        <nav className="flex items-center gap-1.5">
          <NavLink href="/" label="Stock" active={active === "stock"} />
          <NavLink href="/requests" label="Requests" active={active === "requests"} />
          <NavLink href="/warehouse" label="Warehouse" active={active === "warehouse"} />
          <NavLink href="/admin/devices" label="Devices" active={active === "devices"} />
        </nav>
        {user ? <UserMenu name={user.name} email={user.email} /> : null}
      </div>
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-1 px-5 pb-2.5 text-sm text-white/75">
        <CountStat value={units} label={pending === 1 ? "unit in warehouse" : "units in warehouse"} />
        <CountStat value={pending} label={pending === 1 ? "open request" : "open requests"} />
        <span className="text-white/55">{updated ? `Updated ${updated}` : ""}</span>
      </div>
    </header>
  );
}
