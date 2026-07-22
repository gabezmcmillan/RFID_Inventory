/**
 * Warehouse CSV export — the column layout and RFC 4180 formatter ported from
 * `apps/warehouse/app.py:404-462` (`EXPORT_COLUMNS` + the `export_inventory_csv`
 * writer). The domain owns the column order so the field app and any future
 * web/exporter share one source of truth; `exportRows` (repo/inventory) feeds
 * the per-box rows, and {@link exportCsv} turns them into the CSV string the
 * share sheet hands to iOS.
 *
 * Escaping matches Python's `csv.writer` defaults (QUOTE_MINIMAL): a field is
 * quoted only when it contains a comma, double quote, carriage return, or
 * newline; inner double quotes are doubled; rows are terminated by `\r\n`.
 */

import type { Tag } from "../types";

/** One export column: the human header and the {@link Tag} key it reads. */
export interface ExportColumn {
  readonly header: string;
  readonly key: keyof Tag;
}

/**
 * The export column list, in order (app.py:404-422). The header row produced
 * from this is the exact string the plan's Done criteria assert against.
 */
export const EXPORT_COLUMNS: readonly ExportColumn[] = [
  { header: "EPC", key: "epc" },
  { header: "Item Type", key: "item_type" },
  { header: "Item Name", key: "item_name" },
  { header: "BOL #", key: "bol_number" },
  { header: "PO #", key: "po_number" },
  { header: "Building #", key: "building" },
  { header: "Sector", key: "sector" },
  { header: "Checked Out To", key: "checkout_building" },
  { header: "Vendor", key: "vendor" },
  { header: "Item No.", key: "sku" },
  { header: "Mfc Date", key: "mfc_date" },
  { header: "Units Remaining", key: "remaining" },
  { header: "Units Total", key: "quantity" },
  { header: "Status", key: "status" },
  { header: "Received", key: "received_at" },
  { header: "Checked Out", key: "delivered_at" },
  { header: "Flag", key: "flag" },
];

/** The exact header row, as a single CSV line (no trailing newline). */
export const EXPORT_HEADER_ROW: string = EXPORT_COLUMNS.map((c) => csvEscape(c.header)).join(",");

/**
 * Quote a single CSV field per RFC 4180 / Python `csv.writer` QUOTE_MINIMAL:
 * wrap in double quotes and double any inner quotes when the field contains a
 * comma, double quote, carriage return, or newline; otherwise emit it raw.
 */
export function csvEscape(value: string): string {
  if (value === "") return "";
  if (/["\r\n,]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Render one {@link Tag} as a CSV row (no trailing newline). */
export function csvRow(tag: Tag): string {
  return EXPORT_COLUMNS.map((c) => csvEscape(String(tag[c.key] ?? ""))).join(",");
}

/**
 * Build the full CSV document for a set of per-box rows: the header row
 * followed by one row per tag, each terminated by `\r\n` (RFC 4180). Mirrors
 * `apps/warehouse/app.py:440-462`'s `export_inventory_csv` body.
 */
export function exportCsv(rows: readonly Tag[]): string {
  const lines: string[] = [EXPORT_HEADER_ROW];
  for (const tag of rows) {
    lines.push(csvRow(tag));
  }
  return `${lines.join("\r\n")}\r\n`;
}
