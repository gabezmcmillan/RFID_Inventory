/**
 * `extract.test.ts` — the heuristics port's fixture suite (plan 007 step 1).
 *
 * Four synthetic OCR texts cover the labeled-value matchers (same-line,
 * table-header, the P.O. Box trap, the BOL-DATE date rejection) plus the
 * vendor matcher (exact, suffix-stripped, fuzzy ≥0.8, below-0.8 → "") and the
 * PO==BOL collapse. Fixtures define correctness for the port.
 */

import { describe, expect, test } from "vitest";

import { cleanValue, extractFields, matchVendor, sequenceRatio } from "./extract";

const VENDORS = ["Acme Corp", "Global Supply Inc", "Midwest Steel LLC"];

describe("extractFields", () => {
  test("(a) same-line `BOL NO: 123456789` + exact vendor near a hint", () => {
    const text = "BILL OF LADING NO: 123456789\nPO # 44821\nShipper: Acme Corp";
    const f = extractFields(text, VENDORS);
    expect(f.bol_number).toBe("123456789");
    expect(f.po_number).toBe("44821");
    expect(f.vendor).toBe("Acme Corp");
  });

  test("(b) table-header layout: label line, value on the next line", () => {
    const text = "BOL NO.\n123456789\nPURCHASE ORDER\n44821\nVendor\nGlobal Supply Inc";
    const f = extractFields(text, VENDORS);
    expect(f.bol_number).toBe("123456789");
    expect(f.po_number).toBe("44821");
    expect(f.vendor).toBe("Global Supply Inc");
  });

  test("(c) P.O. Box trap rejected, real `PO # 44821` kept; suffix-stripped vendor", () => {
    // `B.L.` (not `B/L`) — the Python `_BOL_LABEL` alternation is `B\s*/\s*B`
    // (a verbatim "B/B"), so this fixture uses the `B\.L\.?` arm that does match.
    const text = "Ship From: ACME\nP.O. Box 12345\nPO # 44821\nB.L. 998877665544";
    const f = extractFields(text, VENDORS);
    expect(f.bol_number).toBe("998877665544");
    expect(f.po_number).toBe("44821");
    expect(f.vendor).toBe("Acme Corp");
  });

  test("(d) a date next to `BOL DATE` is rejected, not taken as the BOL number", () => {
    const text = "BOL DATE: 07/07/2026\nBOL NO: 55512123000\nPO 778899001122";
    const f = extractFields(text, VENDORS);
    expect(f.bol_number).toBe("55512123000");
    expect(f.po_number).toBe("778899001122");
    expect(f.bol_number).not.toContain("07/07/2026");
  });

  test("PO == BOL collapses to the BOL only (shared BOL/PO line)", () => {
    const text = "BOL NO 424242424242\nPO NO 424242424242\nShipper: Acme Corp";
    const f = extractFields(text, VENDORS);
    expect(f.bol_number).toBe("424242424242");
    expect(f.po_number).toBe("");
  });

  test("empty text yields all-empty fields", () => {
    const f = extractFields("   \n  ", VENDORS);
    expect(f).toEqual({ bol_number: "", po_number: "", vendor: "" });
  });
});

describe("matchVendor", () => {
  test("exact word-boundary match", () => {
    expect(matchVendor("Some header\nAcme Corp\nrest", VENDORS)).toBe("Acme Corp");
  });

  test("suffix-stripped: printed `ACME` matches the table's `Acme Corp`", () => {
    expect(matchVendor("ACME", VENDORS)).toBe("Acme Corp");
  });

  test("fuzzy ≥ 0.8: a near-miss spelling still matches", () => {
    // "Acme Corpp" vs variant "acme corp" → one extra letter; ratio well above 0.8.
    expect(matchVendor("Vendor: Acme Corpp", VENDORS)).toBe("Acme Corp");
  });

  test("below 0.8: too-different spelling matches nothing", () => {
    expect(matchVendor("Shipper: Axxxe Korp", VENDORS)).toBe("");
  });

  test("no vendors → empty", () => {
    expect(matchVendor("Acme Corp", [])).toBe("");
  });
});

describe("cleanValue", () => {
  test("rejects a date-shaped value", () => {
    expect(cleanValue("07/07/2026")).toBe("");
  });

  test("rejects a token with no digit", () => {
    expect(cleanValue("PREPAID")).toBe("");
  });

  test("strips a 2+ letter run glued after a digit", () => {
    expect(cleanValue("79299Shipper")).toBe("79299");
  });
});

describe("sequenceRatio", () => {
  test("identical strings ratio 1.0", () => {
    expect(sequenceRatio("acme", "acme")).toBeCloseTo(1.0, 6);
  });

  test("ratio for a one-letter extension is above 0.8", () => {
    // "acme corp" vs "acme corpp": matches "acme corp" (8) over total 9+10=19 → 16/19 ≈ 0.842.
    expect(sequenceRatio("acme corp", "acme corpp")).toBeGreaterThan(0.8);
  });
});
