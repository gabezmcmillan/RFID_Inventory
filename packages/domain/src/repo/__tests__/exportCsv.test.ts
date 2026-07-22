import { describe, expect, test } from "vitest";

import { exportCsv, csvEscape, EXPORT_COLUMNS, EXPORT_HEADER_ROW } from "../../index";
import type { Tag } from "../../index";

/** Minimal tag with only the export-relevant fields set; the rest default to "". */
function tag(over: Partial<Tag>): Tag {
  return {
    epc: "",
    item_type: "",
    item_name: "",
    bol_number: "",
    po_number: "",
    bol_doc_id: null,
    building: "",
    sector: "",
    vendor: "",
    sku: "",
    mfc_date: "",
    quantity: 0,
    remaining: 0,
    status: "",
    received_at: "",
    delivered_at: "",
    checkout_building: "",
    flag: "",
    flagged_at: "",
    ...over,
  };
}

describe("exportCsv", () => {
  test("the header row matches the plan's exact column list", () => {
    expect(EXPORT_HEADER_ROW).toBe(
      "EPC,Item Type,Item Name,BOL #,PO #,Building #,Sector,Checked Out To,Vendor,Item No.,Mfc Date,Units Remaining,Units Total,Status,Received,Checked Out,Flag",
    );
  });

  test("EXPORT_COLUMNS has 17 columns in the right order", () => {
    expect(EXPORT_COLUMNS.map((c) => c.header)).toEqual([
      "EPC",
      "Item Type",
      "Item Name",
      "BOL #",
      "PO #",
      "Building #",
      "Sector",
      "Checked Out To",
      "Vendor",
      "Item No.",
      "Mfc Date",
      "Units Remaining",
      "Units Total",
      "Status",
      "Received",
      "Checked Out",
      "Flag",
    ]);
  });

  test("a plain row is written verbatim with CRLF termination", () => {
    const csv = exportCsv([
      tag({
        epc: "424730310100000000000001",
        item_type: "TSC",
        bol_number: "BOL1",
        building: "6",
        quantity: 4,
        remaining: 3,
        status: "Partial",
      }),
    ]);
    expect(csv).toBe(
      "EPC,Item Type,Item Name,BOL #,PO #,Building #,Sector,Checked Out To,Vendor,Item No.,Mfc Date,Units Remaining,Units Total,Status,Received,Checked Out,Flag\r\n" +
        "424730310100000000000001,TSC,,BOL1,,6,,,,,,3,4,Partial,,,\r\n",
    );
  });

  test("fields with comma/quote/newline are RFC 4180 quoted and inner quotes doubled", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("")).toBe("");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape("line1\rline2")).toBe('"line1\rline2"');
  });

  test("a field containing a comma is quoted within its row", () => {
    const csv = exportCsv([
      tag({
        epc: "AA" + "0".repeat(22),
        item_type: "TSC",
        bol_number: "BOL1",
        building: "6",
        quantity: 2,
        remaining: 0,
        status: "Delivered",
        checkout_building: "7",
        // A realistic flag with a comma exercises in-row quoting.
        flag: "Checked out to Bldg 7, received for Bldg 6",
      }),
    ]);
    const rows = csv.split("\r\n");
    expect(rows[0]).toBe(EXPORT_HEADER_ROW);
    expect(rows[1]).toContain('"Checked out to Bldg 7, received for Bldg 6"');
  });
});
