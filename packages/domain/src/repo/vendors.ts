/**
 * Vendor repository: `listVendors`, `addVendor`, `removeVendor`
 * (db.py:1318-1344).
 */

import type { SqlDatabase } from "../sql.js";
import { withTransaction } from "../sql.js";
import type { VendorResult } from "../types.js";
import { logEvent } from "./events.js";

/** All vendor names, case-insensitive order (db.py:1318-1322). */
export async function listVendors(db: SqlDatabase): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM vendors ORDER BY name COLLATE NOCASE",
  );
  return rows.map((r) => r.name);
}

/** Add a vendor (idempotent via INSERT OR IGNORE) and log `VENDOR_ADD` (db.py:1324-1335). */
export async function addVendor(db: SqlDatabase, name: string): Promise<VendorResult> {
  const clean = (name ?? "").toString().trim();
  if (!clean) {
    return { ok: false, message: "Vendor name is required.", vendors: await listVendors(db) };
  }
  await withTransaction(db, async () => {
    await db.run("INSERT OR IGNORE INTO vendors (name) VALUES (?)", [clean]);
    await logEvent(db, "VENDOR_ADD", "", "", "", "", "", clean);
  });
  return { ok: true, message: `Added vendor '${clean}'.`, vendors: await listVendors(db) };
}

/** Remove a vendor and log `VENDOR_DEL` (db.py:1337-1344). */
export async function removeVendor(db: SqlDatabase, name: string): Promise<VendorResult> {
  const clean = (name ?? "").toString().trim();
  await withTransaction(db, async () => {
    await db.run("DELETE FROM vendors WHERE name=?", [clean]);
    await logEvent(db, "VENDOR_DEL", "", "", "", "", "", clean);
  });
  return { ok: true, message: `Removed vendor '${clean}'.`, vendors: await listVendors(db) };
}
