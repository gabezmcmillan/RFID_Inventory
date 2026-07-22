/**
 * CLI entry for the legacy importer:
 *   pnpm --filter @rfid/domain exec tsx src/importer/cli.ts --from <legacy.db> --to <new.db>
 *
 * Prints a per-table `legacy=N imported=N` line and the seeded EPC serial, exiting
 * nonzero on any mismatch.
 */

import { importLegacy } from "./importLegacy.js";

function parseArgs(argv: string[]): { from: string; to: string } {
  let from = "";
  let to = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--from") {
      from = argv[++i] ?? "";
    } else if (a === "--to") {
      to = argv[++i] ?? "";
    } else if (a.startsWith("--from=")) {
      from = a.slice("--from=".length);
    } else if (a.startsWith("--to=")) {
      to = a.slice("--to=".length);
    }
  }
  if (!from || !to) {
    console.error("Usage: cli.ts --from <legacy.db> --to <new.db>");
    process.exit(2);
  }
  return { from, to };
}

async function main(): Promise<void> {
  const { from, to } = parseArgs(process.argv.slice(2));
  try {
    const report = await importLegacy(from, to);
    for (const t of report.tables) {
      console.log(`${t.table}: legacy=${t.legacy} imported=${t.imported}`);
    }
    console.log(`epc_serial: ${report.epcSerial}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

void main();
