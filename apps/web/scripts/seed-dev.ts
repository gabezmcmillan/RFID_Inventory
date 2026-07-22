/**
 * Dev-only seed: opens the local web database (the same one the dev server
 * uses) and inserts sample stock through the domain repos so the jobsite UI
 * has something to browse and request. Run with:
 *
 *   pnpm --filter @rfid/web exec tsx scripts/seed-dev.ts
 *
 * It drops nothing and is idempotent-ish (it just adds more boxes each run);
 * delete `../../.dev-data/web.db` to start clean. The web app only ever
 * inserts `requests`; this script writes `tags` through `receiveShipment`
 * purely to stage browseable stock for local development.
 */

import { deliverUnits, receiveShipment } from "@rfid/domain";

import { getDb } from "../src/lib/db";

const epc = (prefix: string, n: number): string =>
  prefix + n.toString(16).toUpperCase().padStart(24 - prefix.length, "0");

async function main(): Promise<void> {
  const db = await getDb();

  // Plain types across BOLs and buildings.
  await receiveShipment(db, [epc("AA", 1), epc("AA", 2)], "TSC", "6", "BOL-1001", "Acme", {
    quantity: 10,
  });
  await receiveShipment(db, [epc("AB", 1)], "TSC", "6", "BOL-1002", "Beta Supply", {
    quantity: 6,
  });
  await receiveShipment(db, [epc("AC", 1)], "TSC", "7", "BOL-1001", "Acme", { quantity: 4 });

  await receiveShipment(db, [epc("BA", 1)], "CDU", "8", "BOL-2001", "Gamma", { quantity: 8 });

  // Named type (W.I.F.) with two components, one partially drawn.
  await receiveShipment(db, [epc("WA", 1)], "W.I.F.", "6", "BOL-3001", "Acme", {
    item_name: "Bracket",
    quantity: 4,
  });
  await receiveShipment(db, [epc("WB", 1)], "W.I.F.", "6", "BOL-3001", "Acme", {
    item_name: "Plate",
    quantity: 6,
  });
  await deliverUnits(db, epc("WA", 1), 2); // Bracket -> Partial (2 of 4)

  console.log("Seeded dev stock: TSC (Bldg 6 & 7), CDU (Bldg 8), W.I.F. Bracket/Plate (Bldg 6).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
