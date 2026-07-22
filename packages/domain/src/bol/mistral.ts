/**
 * BOL field extraction through Mistral's OCR cloud API — a 1:1 TypeScript port
 * of `apps/warehouse/ocr_mistral.py`.
 *
 * One POST to `https://api.mistral.ai/v1/ocr` with the BOL document (as a
 * base64 `data:` URL) and a JSON-schema "document annotation": Mistral OCRs the
 * pages layout-aware and a vision LLM fills `{bol_number, po_number, vendor,
 * items}` directly from the document. The annotation schema and prompt are
 * ported verbatim from `ocr_mistral.py:48-128`; the post-processing (lines
 * 179-244) is ported in full.
 *
 * The vendor answer is never trusted verbatim: it is re-matched against the
 * vendors table via {@link matchVendor} (the `"vendor: <answer>"` prefix trick
 * of `ocr_mistral.py:196-197`), so OCR/model noise can't invent a vendor (same
 * guarantee as the local path). Any failure (offline, timeout, bad response)
 * returns `null` so the caller falls back to the local pipeline — this module
 * must never break a scan.
 *
 * Pure TypeScript: `fetch` is taken as a parameter (`fetchImpl`, defaulting to
 * the global) so the domain package never assumes a fetch global. The field app
 * passes its own fetch (or the RN global); tests pass a stub.
 */

import { matchVendor } from "./extract.js";

/** The OCR endpoint (ocr_mistral.py `_OCR_URL`). */
const OCR_URL = "https://api.mistral.ai/v1/ocr";

/** Mistral OCR model (ocr_mistral.py uses `config.MISTRAL_OCR_MODEL`). */
const MISTRAL_OCR_MODEL = "mistral-ocr-latest";

/** Per-request timeout (ocr_mistral.py uses `config.MISTRAL_OCR_TIMEOUT_SECONDS`). */
const MISTRAL_OCR_TIMEOUT_MS = 45_000;

/** Max line items kept from the model's items array (ocr_mistral.py `MAX_LINE_ITEMS`). */
const MAX_LINE_ITEMS = 30;

/** Words a model sometimes emits in prose that mean "absent" (ocr_mistral.py `_clean`). */
const NULL_WORDS = new Set(["none", "n/a", "na", "not present", "unknown"]);

/** A document to OCR: a MIME type plus its raw bytes. */
export interface MistralDocument {
  /** `application/pdf` (sent as `document_url`) or `image/jpeg` (sent as `image_url`). */
  readonly mimeType: "application/pdf" | "image/jpeg";
  /** Raw document bytes (base64-encoded into a `data:` URL for the request). */
  readonly data: Uint8Array;
}

/** The extracted-fields result of a successful Mistral OCR call. */
export interface MistralExtraction {
  bol_number: string;
  po_number: string;
  vendor: string;
  ocr_text: string;
  line_items: MistralLineItem[];
}

/** A line item with a normalized positive-integer quantity. */
export interface MistralLineItem {
  item_no: string;
  item_name: string;
  quantity: string;
}

/** Minimal fetch shape this client needs (a slice of the global `fetch`). */
export type FetchImpl = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Input to {@link extractFieldsViaMistral}. */
export interface ExtractViaMistralInput {
  /** Mistral API key (read from `expo-secure-store` by the caller). */
  apiKey: string;
  /** The document to OCR. */
  document: MistralDocument;
  /** Known vendor names (the vendor is matched only against these). */
  vendors: readonly string[];
  /** Fetch implementation; defaults to the global `fetch`. */
  fetchImpl?: FetchImpl;
}

// -- annotation schema + prompt (VERBATIM from ocr_mistral.py:48-128) ---------

/** The JSON-schema document annotation (ocr_mistral.py `_ANNOTATION_SCHEMA`). */
const ANNOTATION_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "bol_fields",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["bol_number", "po_number", "vendor", "items"],
      properties: {
        bol_number: {
          type: "string",
          description:
            "The bill of lading number (labeled BOL, B/L, BL or Bill of Lading No). Empty string if not present.",
        },
        po_number: {
          type: "string",
          description:
            "The purchase order / customer order number (labeled PO, P.O. or Purchase Order). A 'P.O. Box' is a postal address, NOT a PO number. Empty string if not present.",
        },
        vendor: {
          type: "string",
          description:
            "The vendor: the company that supplied the goods (usually the shipper / ship-from party, not the carrier and not the consignee). Empty string if not present.",
        },
        items: {
          type: "array",
          description:
            "The goods line items on the document, one entry per distinct product line. Skip totals, freight charges, and pallet/packaging rows. Empty array if no line items are listed.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["item_no", "item_name", "quantity"],
            properties: {
              item_no: {
                type: "string",
                description:
                  "The line's part / item / product number, e.g. 4000-222-01. Empty string if the line has none.",
              },
              item_name: {
                type: "string",
                description:
                  "The line's product description / name, e.g. CATCH BASIN SUPPORT.",
              },
              quantity: {
                type: "string",
                description:
                  "The quantity shipped on this line (the shipped/ship qty column, not ordered or back-ordered), e.g. 700. Empty string if not shown.",
              },
            },
          },
        },
      },
    },
  },
} as const;

/** The base extraction prompt (ocr_mistral.py `_ANNOTATION_PROMPT`). */
const ANNOTATION_PROMPT =
  "This document is a freight bill of lading for a construction-materials " +
  "warehouse. Extract the bill of lading number, the purchase order " +
  "number, the vendor (supplier/shipper company), and the goods line " +
  "items (each line's item/part number, product description and shipped " +
  "quantity; ignore totals, freight charges and packaging rows). Copy " +
  "values exactly as printed; use an empty string for anything not on " +
  "the document.";

/** Build the prompt, appending the known-vendors hint when any are known (ocr_mistral.py `_annotation_prompt`). */
function annotationPrompt(vendors: readonly string[]): string {
  const names = vendors.filter((v) => (v ?? "").trim() !== "");
  if (!names.length) return ANNOTATION_PROMPT;
  return `${ANNOTATION_PROMPT} Known vendors (prefer the matching one for the vendor field): ${names.join("; ")}.`;
}

// -- base64 (pure TS; RN- and Node-safe) ---------------------------------------

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64-encode a byte array without `btoa`/`Buffer` (RN-safe, Node-safe). */
function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out +=
      (B64_ALPHABET[(triple >> 18) & 63] ?? "") +
      (B64_ALPHABET[(triple >> 12) & 63] ?? "") +
      (B64_ALPHABET[(triple >> 6) & 63] ?? "") +
      (B64_ALPHABET[triple & 63] ?? "");
  }
  const rem = bytes.length % 3;
  if (rem === 1) out = `${out.slice(0, -2)}==`;
  else if (rem === 2) out = `${out.slice(0, -1)}=`;
  return out;
}

// -- public entry point --------------------------------------------------------

/**
 * Mistral-extracted BOL fields for the document, or `null` on any failure
 * (ocr_mistral.py `extract_fields`).
 *
 * Blocking (one HTTPS round trip); the caller decides threading. The result
 * has `""` for unknowns and `[]` for no line items. The vendor is re-matched
 * against `vendors` via {@link matchVendor} — never the model's raw string.
 */
export async function extractFieldsViaMistral(input: ExtractViaMistralInput): Promise<MistralExtraction | null> {
  const { apiKey, document, vendors } = input;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (!apiKey || !fetchImpl) return null;

  const dataUrl = `data:${document.mimeType};base64,${base64(document.data)}`;
  const isPdf = document.mimeType === "application/pdf";
  const payload = {
    model: MISTRAL_OCR_MODEL,
    document: isPdf
      ? { type: "document_url", document_url: dataUrl }
      : { type: "image_url", image_url: dataUrl },
    document_annotation_format: ANNOTATION_SCHEMA,
    document_annotation_prompt: annotationPrompt(vendors),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MISTRAL_OCR_TIMEOUT_MS);
  let body: unknown;
  try {
    const resp = await fetchImpl(OCR_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    body = await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  return parseExtraction(body, vendors);
}

/**
 * Parse the Mistral response body into a {@link MistralExtraction} (or `null`
 * when nothing usable came back). Split out so tests can feed canned bodies
 * without a fetch round trip.
 */
function parseExtraction(body: unknown, vendors: readonly string[]): MistralExtraction | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { pages?: unknown; document_annotation?: unknown };
  const pages = Array.isArray(b.pages) ? b.pages : [];
  const markdown = pages
    .map((p) => (typeof p === "object" && p !== null ? String((p as { markdown?: unknown }).markdown ?? "") : ""))
    .join("\n\n")
    .trim();

  let annotation: Record<string, unknown> = {};
  try {
    const raw = b.document_annotation;
    if (typeof raw === "string" && raw.trim()) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") annotation = parsed as Record<string, unknown>;
    }
  } catch {
    annotation = {};
  }

  if (!markdown && Object.keys(annotation).length === 0) return null;

  const bol = cleanString(annotation["bol_number"]);
  let po = cleanString(annotation["po_number"]);
  if (po && bol && po.toLowerCase() === bol.toLowerCase()) po = "";
  // Constrain the vendor to the vendors table (exact/fuzzy); the model's answer
  // is just the strongest hint in the text — never used verbatim.
  const modelVendor = cleanString(annotation["vendor"]);
  const vendor = matchVendor(`vendor: ${modelVendor}\n${markdown}`, vendors);
  return {
    bol_number: bol,
    po_number: po,
    vendor,
    ocr_text: markdown,
    line_items: cleanItems(annotation["items"]),
  };
}

// -- post-processing (ocr_mistral.py:179-244) ----------------------------------

/** Treat prose null-words as empty (ocr_mistral.py `_clean`). */
function cleanString(value: unknown): string {
  const v = (value ?? "").toString().trim();
  if (NULL_WORDS.has(v.toLowerCase())) return "";
  return v;
}

/** Normalized line items from the model's items array (ocr_mistral.py `_clean_items`). */
function cleanItems(raw: unknown): MistralLineItem[] {
  if (!Array.isArray(raw)) return [];
  const items: MistralLineItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const item_no = cleanString(e["item_no"]);
    const item_name = cleanString(e["item_name"]);
    if (!item_no || seen.has(item_no.toLowerCase())) continue;
    seen.add(item_no.toLowerCase());
    items.push({ item_no, item_name, quantity: cleanQuantity(e["quantity"]) });
    if (items.length >= MAX_LINE_ITEMS) break;
  }
  return items;
}

/** Quantity as a positive-integer string ("" when absent/unparseable) (ocr_mistral.py `_clean_quantity`). */
function cleanQuantity(value: unknown): string {
  const cleaned = cleanString(value).replace(/,/g, "");
  if (!cleaned) return "";
  const qty = Math.round(Number.parseFloat(cleaned));
  if (!Number.isFinite(qty)) return "";
  return qty > 0 ? String(qty) : "";
}
