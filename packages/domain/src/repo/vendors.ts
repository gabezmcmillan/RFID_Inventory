/**
 * Vendor repository: `listVendors`, `addVendor`, `removeVendor`
 * (db.py:1318-1344).
 */

import { eq, sql } from "drizzle-orm";

import type { DomainDb } from "../db";
import { withTransaction } from "../db";
import { vendors } from "../schema";
import type { VendorResult } from "../types";
import { logEvent } from "./events";

/** All vendor names, case-insensitive order (db.py:1318-1322). */
export async function listVendors(db: DomainDb): Promise<string[]> {
  const rows = await db
    .select({ name: vendors.name })
    .from(vendors)
    .orderBy(sql`${vendors.name} COLLATE NOCASE`);
  return rows.map((r) => r.name);
}

/** Add a vendor (idempotent via ON CONFLICT DO NOTHING) and log `VENDOR_ADD` (db.py:1324-1335). */
export async function addVendor(db: DomainDb, name: string): Promise<VendorResult> {
  const clean = (name ?? "").toString().trim();
  if (!clean) {
    return { ok: false, message: "Vendor name is required.", vendors: await listVendors(db) };
  }
  await withTransaction(db, async () => {
    await db.insert(vendors).values({ name: clean }).onConflictDoNothing();
    await logEvent(db, "VENDOR_ADD", "", "", "", "", "", clean);
  });
  return { ok: true, message: `Added vendor '${clean}'.`, vendors: await listVendors(db) };
}

/** Remove a vendor and log `VENDOR_DEL` (db.py:1337-1344). */
export async function removeVendor(db: DomainDb, name: string): Promise<VendorResult> {
  const clean = (name ?? "").toString().trim();
  await withTransaction(db, async () => {
    await db.delete(vendors).where(eq(vendors.name, clean));
    await logEvent(db, "VENDOR_DEL", "", "", "", "", "", clean);
  });
  return { ok: true, message: `Removed vendor '${clean}'.`, vendors: await listVendors(db) };
}
