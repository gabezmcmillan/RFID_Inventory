/**
 * `mistral.test.ts` — the Mistral OCR client suite (plan 007 step 2). A stubbed
 * `fetchImpl` feeds canned response bodies; the five cases cover the happy path
 * (with vendor re-match + line-item normalization), the PO==BOL collapse, a
 * network error, malformed annotation JSON, and a non-OK HTTP status.
 */

import { describe, expect, test } from "vitest";

import { extractFieldsViaMistral, type FetchImpl, type MistralDocument } from "./mistral";

const PDF_DOC: MistralDocument = { mimeType: "application/pdf", data: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]) };

/** Build a fetch stub returning a canned body with the given ok/status. */
function makeFetch(body: unknown, ok = true, status = 200): FetchImpl {
  return async () => ({ ok, status, json: async () => body });
}

describe("extractFieldsViaMistral", () => {
  test("happy path: parses the body, re-matches the vendor, normalizes line items", async () => {
    const body = {
      pages: [{ markdown: "BOL NO: 123456789\nPO # 44821\nShipper: Acme Corp" }],
      document_annotation: JSON.stringify({
        bol_number: "123456789",
        po_number: "44821",
        vendor: "ACME Corporation",
        items: [
          { item_no: "4000-222-01", item_name: "CATCH BASIN SUPPORT", quantity: "700.00" },
          { item_no: "", item_name: "FREIGHT", quantity: "1" },
          { item_no: "4000-222-01", item_name: "DUP", quantity: "2" },
          { item_no: "4000-333-02", item_name: "VALVE", quantity: "1,500" },
        ],
      }),
    };
    const result = await extractFieldsViaMistral({
      apiKey: "key",
      document: PDF_DOC,
      vendors: ["Acme Corp"],
      fetchImpl: makeFetch(body),
    });
    expect(result).not.toBeNull();
    expect(result!.bol_number).toBe("123456789");
    expect(result!.po_number).toBe("44821");
    // The model's "ACME Corporation" is re-matched to the table's "Acme Corp".
    expect(result!.vendor).toBe("Acme Corp");
    expect(result!.ocr_text).toBe("BOL NO: 123456789\nPO # 44821\nShipper: Acme Corp");
    // No-item_no dropped, duplicate "4000-222-01" collapsed, quantities normalized.
    expect(result!.line_items).toEqual([
      { item_no: "4000-222-01", item_name: "CATCH BASIN SUPPORT", quantity: "700" },
      { item_no: "4000-333-02", item_name: "VALVE", quantity: "1500" },
    ]);
  });

  test("PO == BOL collapses to the BOL only (no P.O. Box invention)", async () => {
    const body = {
      pages: [{ markdown: "BOL 999000111222" }],
      document_annotation: JSON.stringify({
        bol_number: "999000111222",
        po_number: "999000111222",
        vendor: "",
        items: [],
      }),
    };
    const result = await extractFieldsViaMistral({
      apiKey: "key",
      document: PDF_DOC,
      vendors: [],
      fetchImpl: makeFetch(body),
    });
    expect(result).not.toBeNull();
    expect(result!.bol_number).toBe("999000111222");
    expect(result!.po_number).toBe("");
    expect(result!.vendor).toBe("");
  });

  test("a network error (fetch rejection) → null", async () => {
    const failing: FetchImpl = async () => {
      throw new Error("offline");
    };
    const result = await extractFieldsViaMistral({
      apiKey: "key",
      document: PDF_DOC,
      vendors: [],
      fetchImpl: failing,
    });
    expect(result).toBeNull();
  });

  test("malformed annotation JSON still returns the markdown shape with a heuristic vendor", async () => {
    const body = {
      pages: [{ markdown: "BOL 555000111222\nVendor: Acme Corp" }],
      document_annotation: "not-json{",
    };
    const result = await extractFieldsViaMistral({
      apiKey: "key",
      document: PDF_DOC,
      vendors: ["Acme Corp"],
      fetchImpl: makeFetch(body),
    });
    expect(result).not.toBeNull();
    expect(result!.ocr_text).toBe("BOL 555000111222\nVendor: Acme Corp");
    // No annotation parsed → empty BOL/PO, vendor matched from the markdown.
    expect(result!.bol_number).toBe("");
    expect(result!.po_number).toBe("");
    expect(result!.vendor).toBe("Acme Corp");
    expect(result!.line_items).toEqual([]);
  });

  test("a non-OK HTTP status → null", async () => {
    const result = await extractFieldsViaMistral({
      apiKey: "key",
      document: PDF_DOC,
      vendors: [],
      fetchImpl: makeFetch({ pages: [] }, false, 500),
    });
    expect(result).toBeNull();
  });

  test("no API key → null (never calls fetch)", async () => {
    let called = false;
    const fetchImpl: FetchImpl = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const result = await extractFieldsViaMistral({
      apiKey: "",
      document: PDF_DOC,
      vendors: [],
      fetchImpl,
    });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });
});
