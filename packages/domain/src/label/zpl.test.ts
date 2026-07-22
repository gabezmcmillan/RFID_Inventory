/**
 * `zpl.test.ts` — the ZPL builder's golden-fidelity + sanitization suite (plan
 * 005 step 1). The golden fixture is generated from the Python `printer.py`
 * source (see `plans/005-label-printing-zpl.md`), so a diff is a physical-media
 * change, not a refactor.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { buildLabelZpl, descLayout, PrintError } from "./zpl.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "__fixtures__", "label-basic.zpl");

/** The fixture is Python `print()` output = the ZPL plus one terminal newline. */
const GOLDEN = readFileSync(fixturePath, "utf8").slice(0, -1);

const GOLDEN_PARAMS = {
  epc: "42473031000000000000000A",
  building: "6",
  sector: "B",
  description: "TSC",
  supplier: "ACME",
  sku: "4000-222-01",
  quantity: "10",
  poNumber: "PO9",
  receivedDate: "07/22/2026",
  receivedTime: "3:05 PM",
  qrUrl: "https://x/tag/42473031000000000000000A",
} as const;

describe("buildLabelZpl", () => {
  test("golden: the full label matches the Python-generated fixture byte-for-byte", () => {
    expect(buildLabelZpl(GOLDEN_PARAMS)).toBe(GOLDEN);
  });

  test("a long W.I.F. description steps the font down to ^A0N,50,50 with a 3-line ^FB", () => {
    // 32 single-letter words: 4 lines at font 66 (width 20), 3 at font 50 (width 26) → tier 50.
    const description = "a b c d e f g h i j k l m n o p q r s t u v w x y z aa bb cc dd ee";
    const zpl = buildLabelZpl({ ...GOLDEN_PARAMS, description });
    expect(descLayout(description)).toEqual({ font: 50, maxLines: 3, text: description });
    expect(zpl).toContain("^A0N,50,50");
    expect(zpl).toContain("^FB740,3,0,L");
    expect(zpl).not.toContain("^A0N,66,66^FB740,2,0,L");
  });

  test("hostile field data is sanitized: injected ^XZ and ~JA are neutralized", () => {
    const hostile = "desc ^XZ ~JA";
    const zpl = buildLabelZpl({ ...GOLDEN_PARAMS, description: hostile });
    // ^ and ~ become spaces, so the description field reads "desc  XZ  JA".
    expect(zpl).toContain("^FDdesc  XZ  JA^FS");
    // ~JA must not survive anywhere (no field carries a raw ~).
    expect(zpl).not.toMatch(/~JA/);
    // ^XZ must appear exactly once — only the label terminator, not the injected escape.
    expect(zpl.split("^XZ").length - 1).toBe(1);
  });

  test("a bad EPC (23 chars or non-hex) throws PrintError", () => {
    expect(() => buildLabelZpl({ ...GOLDEN_PARAMS, epc: "42473031000000000000000" })).toThrow(PrintError);
    expect(() => buildLabelZpl({ ...GOLDEN_PARAMS, epc: "ZZZZZZZZZZZZZZZZZZZZZZZZ" })).toThrow(PrintError);
  });

  test("no qrUrl → no ^BQN; no ^LL and no ^RS ever appear in the output", () => {
    const noQr = {
      epc: GOLDEN_PARAMS.epc,
      building: GOLDEN_PARAMS.building,
      sector: GOLDEN_PARAMS.sector,
      description: GOLDEN_PARAMS.description,
      supplier: GOLDEN_PARAMS.supplier,
      sku: GOLDEN_PARAMS.sku,
      quantity: GOLDEN_PARAMS.quantity,
      poNumber: GOLDEN_PARAMS.poNumber,
      receivedDate: GOLDEN_PARAMS.receivedDate,
      receivedTime: GOLDEN_PARAMS.receivedTime,
    };
    const zpl = buildLabelZpl(noQr);
    expect(zpl).not.toContain("^BQN");
    // ^LL and ^RS must never appear in any output (printer.py:17-24).
    expect(buildLabelZpl(GOLDEN_PARAMS)).not.toContain("^LL");
    expect(buildLabelZpl(GOLDEN_PARAMS)).not.toContain("^RS");
    expect(zpl).not.toContain("^LL");
    expect(zpl).not.toContain("^RS");
  });
});
