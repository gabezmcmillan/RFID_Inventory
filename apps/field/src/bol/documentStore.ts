/**
 * BOL document capture, on-device OCR, and the extraction ladder (plan 007 step
 * 3). A capture saves JPEG pages under `FileSystem.documentDirectory/scans/`
 * as `bol_YYYYMMDD_HHMMSS_pN.jpg` (collision-free naming mirroring
 * `app.py:561-569`), creates/updates the `bol_docs` row, and runs the
 * extraction ladder:
 *
 *   1. If a Mistral API key is set → `@rfid/domain`'s `extractFieldsViaMistral`
 *      (page 1 only for multi-page scans — the multi-page-PDF-assembly
 *      alternative was deferred; the limitation is recorded in the doc row's
 *      `ocr_text` header comment).
 *   2. Else → MLKit `recognize()` per page, join text, run `extractFields`.
 *
 * Any Mistral failure falls back to the local path. An `expo-document-picker`
 * upload (source `"upload"`) runs the same ladder. The domain client never
 * reads storage — the Mistral key is passed in via {@link CaptureDeps}.
 */

import {
  applyBolExtraction,
  createBolDoc,
  extractFields,
  extractFieldsViaMistral,
  getBolDoc,
  setBolDocPages,
  type BolDoc,
  type BolLineItem,
  type DomainDb,
  type FetchImpl,
} from "@rfid/domain";
import { Directory, File, Paths } from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";
import { enqueueBolArtifact } from "../sync/bolUpload";
import { useEffect, useState } from "react";
import DocumentScanner, {
  ResponseType,
  ScanDocumentResponseStatus,
} from "react-native-document-scanner-plugin";
import TextRecognition from "@react-native-ml-kit/text-recognition";

/** Dependencies the capture ladder needs (the Mistral key is passed in, never read from storage here). */
export interface CaptureDeps {
  /** Mistral API key (loaded from `expo-secure-store` by the caller). "" disables the online path. */
  readonly mistralApiKey: string;
  /** Known vendor names (the vendor is matched only against these). */
  readonly vendors: readonly string[];
  /** Fetch implementation forwarded to the domain client (defaults to the global). */
  readonly fetchImpl?: FetchImpl;
}

/** The extraction ladder's result (the shape `applyBolExtraction`/`createBolDoc` consume). */
export interface BolExtraction {
  bol_number: string;
  po_number: string;
  vendor: string;
  ocr_text: string;
  line_items: BolLineItem[];
}

/** Header comment recording the page-1-only Mistral limitation (plan 007 step 3). */
const MISTRAL_PAGE1_NOTE =
  "<!-- plan 007 step 3: Mistral extraction used page 1 only; multi-page extraction is deferred. -->";

// -- naming + paths -----------------------------------------------------------

/** Zero-pad a number to two digits. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYYMMDD_HHMMSS` for a date (mirrors app.py `_new_scan_filename`'s `strftime`). */
function formatStamp(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/**
 * Placeholder BOL number until the operator renames it, e.g. `BOL 07-07 3:12PM`
 * (app.py:572-576 `_default_bol_reference`).
 */
export function defaultBolReference(now = new Date()): string {
  const rawHour = now.getHours() % 12;
  const hour = rawHour === 0 ? 12 : rawHour;
  return `BOL ${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${hour}:${pad2(now.getMinutes())}${now.getHours() < 12 ? "AM" : "PM"}`;
}

/**
 * Map a picked image's MIME type to one the BOL upload grant allows
 * (image/jpeg | image/pdf), or null when the type isn't uploadable. The grant
 * endpoint rejects other content types, so we skip enqueueing those rather
 * than dead-letter them.
 */
function allowedImageContentType(mimeType: string | undefined): "image/jpeg" | "image/png" | null {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "image/jpeg";
  if (mimeType === "image/png") return "image/png";
  return null;
}

/** The `scans/` directory under the document directory, created idempotently. */
function scansDir(): Directory {
  const scans = new Directory(Paths.document, "scans");
  if (!scans.exists) scans.create({ idempotent: true });
  return scans;
}

/** A collision-free base name (mirrors app.py:561-569), probing an existing first file. */
function newBaseName(prefix: string, probe: (base: string) => string, now = new Date()): string {
  const stamp = formatStamp(now);
  let base = `${prefix}_${stamp}`;
  let n = 2;
  while (new File(scansDir(), probe(base)).exists) {
    base = `${prefix}_${stamp}_${n}`;
    n += 1;
  }
  return base;
}

/** The scan base stripped from a scan doc's first-page filename, or `null` for non-scan docs. */
function scanBaseFromFilename(filename: string): string | null {
  const m = filename.match(/^(.*)_p\d+\.jpg$/);
  return m ? (m[1] ?? "") : null;
}

/** The on-disk URIs of `count` scan pages for `base` (`base_p1.jpg` … `base_p{count}.jpg`). */
function pageUrisForBase(base: string, count: number): string[] {
  const uris: string[] = [];
  for (let i = 1; i <= count; i++) uris.push(new File(scansDir(), `${base}_p${i}.jpg`).uri);
  return uris;
}

/** Read a file's bytes (RN-safe via `File.arrayBuffer`). */
export async function readBytes(uri: string): Promise<Uint8Array> {
  const buf = await new File(uri).arrayBuffer();
  return new Uint8Array(buf);
}

/** Copy a source file's bytes into `scans/` under `destName`, returning the destination file. */
async function copyToScans(srcUri: string, destName: string): Promise<File> {
  const bytes = await readBytes(srcUri);
  const dest = new File(scansDir(), destName);
  dest.write(bytes);
  return dest;
}

// -- capture + OCR primitives -------------------------------------------------

/** Open the document scanner; return page file URIs, or `null` if canceled/empty. */
async function capturePages(): Promise<string[] | null> {
  const res = await DocumentScanner.scanDocument({ responseType: ResponseType.ImageFilePath });
  if (res.status !== ScanDocumentResponseStatus.Success) return null;
  const images = res.scannedImages ?? [];
  return images.length > 0 ? images : null;
}

/** Mistral extraction of one JPEG (page 1 of a scan), with the limitation note. */
async function mistralFromImage(imageUri: string, deps: CaptureDeps): Promise<BolExtraction | null> {
  if (!deps.mistralApiKey) return null;
  const result = await extractFieldsViaMistral({
    apiKey: deps.mistralApiKey,
    document: { mimeType: "image/jpeg", data: await readBytes(imageUri) },
    vendors: deps.vendors,
    fetchImpl: deps.fetchImpl,
  });
  if (!result) return null;
  return {
    bol_number: result.bol_number,
    po_number: result.po_number,
    vendor: result.vendor,
    ocr_text: `${MISTRAL_PAGE1_NOTE}\n${result.ocr_text}`,
    line_items: result.line_items,
  };
}

/** Mistral extraction of a whole PDF (one document; Mistral handles its pages). */
async function mistralFromPdf(pdfUri: string, deps: CaptureDeps): Promise<BolExtraction | null> {
  if (!deps.mistralApiKey) return null;
  const result = await extractFieldsViaMistral({
    apiKey: deps.mistralApiKey,
    document: { mimeType: "application/pdf", data: await readBytes(pdfUri) },
    vendors: deps.vendors,
    fetchImpl: deps.fetchImpl,
  });
  if (!result) return null;
  return { ...result, line_items: result.line_items };
}

/** Local fallback: MLKit each image, join, run the ported heuristics. */
async function localFromImages(imageUris: readonly string[], vendors: readonly string[]): Promise<BolExtraction> {
  const parts: string[] = [];
  for (const uri of imageUris) {
    const r = await TextRecognition.recognize(uri);
    parts.push(r.text);
  }
  const text = parts.join("\n\n");
  const f = extractFields(text, vendors);
  return { bol_number: f.bol_number, po_number: f.po_number, vendor: f.vendor, ocr_text: text, line_items: [] };
}

/** Extraction ladder for JPEG pages: Mistral page-1 → local all pages. */
async function ladderFromImages(imageUris: readonly string[], deps: CaptureDeps): Promise<BolExtraction> {
  if (imageUris.length > 0) {
    const mistral = await mistralFromImage(imageUris[0], deps);
    if (mistral) return mistral;
  }
  return localFromImages(imageUris, deps.vendors);
}

/** Extraction ladder for a PDF upload: Mistral whole PDF → empty (no on-device PDF text layer). */
async function ladderFromPdf(pdfUri: string, deps: CaptureDeps): Promise<BolExtraction> {
  const mistral = await mistralFromPdf(pdfUri, deps);
  if (mistral) return mistral;
  return { bol_number: "", po_number: "", vendor: "", ocr_text: "", line_items: [] };
}

// -- public entry points ------------------------------------------------------

/**
 * Scan a BOL with the camera, save the pages, run the ladder, and create a
 * `bol_docs` row (source `"scan"`). Returns the created doc, or `null` if the
 * operator canceled the scan.
 */
export async function captureBolDocument(db: DomainDb, deps: CaptureDeps): Promise<BolDoc | null> {
  const captured = await capturePages();
  if (!captured) return null;

  const base = newBaseName("bol", (b) => `${b}_p1.jpg`);
  const savedUris: string[] = [];
  for (let i = 0; i < captured.length; i++) {
    const file = await copyToScans(captured[i] ?? "", `${base}_p${i + 1}.jpg`);
    savedUris.push(file.uri);
  }
  const extraction = await ladderFromImages(savedUris, deps);
  const reference = extraction.bol_number || defaultBolReference();
  return createBolDoc(
    db,
    reference,
    `${base}_p1.jpg`,
    "scan",
    savedUris.length,
    extraction.vendor,
    extraction.po_number,
    extraction.ocr_text,
    extraction.line_items,
  );
}

/**
 * Append a captured page to an existing scan document, then re-run the ladder
 * over the whole document and fold it in via {@link applyBolExtraction}. Only
 * scan docs (filename `…_p1.jpg`) support add-page; returns `null` otherwise
 * or if the operator canceled.
 */
export async function addPageToBolDocument(db: DomainDb, docId: string, deps: CaptureDeps): Promise<BolDoc | null> {
  const doc = await getBolDoc(db, docId);
  if (!doc) return null;
  const base = scanBaseFromFilename(doc.filename);
  if (!base) return null;

  const captured = await capturePages();
  if (!captured) return null;

  for (let i = 0; i < captured.length; i++) {
    await copyToScans(captured[i] ?? "", `${base}_p${doc.pages + i + 1}.jpg`);
  }
  const totalPages = doc.pages + captured.length;
  await setBolDocPages(db, docId, totalPages);

  const allUris = pageUrisForBase(base, totalPages);
  const extraction = await ladderFromImages(allUris, deps);
  return applyBolExtraction(
    db,
    docId,
    extraction.bol_number,
    extraction.vendor,
    extraction.po_number,
    extraction.ocr_text,
    extraction.line_items,
  );
}

/**
 * Pick an existing PDF/image via the document picker, save it under `scans/`,
 * run the ladder, and create a `bol_docs` row (source `"upload"`). Returns the
 * created doc, or `null` if canceled.
 */
export async function uploadBolDocument(db: DomainDb, deps: CaptureDeps): Promise<BolDoc | null> {
  const pick = await DocumentPicker.getDocumentAsync({
    type: ["application/pdf", "image/*"],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (pick.canceled) return null;
  const asset = pick.assets[0];
  if (!asset) return null;

  const isPdf = asset.mimeType === "application/pdf" || asset.name.toLowerCase().endsWith(".pdf");
  const ext = isPdf ? "pdf" : "jpg";
  const base = newBaseName("bol_upload", (b) => `${b}.${ext}`);
  const filename = `${base}.${ext}`;
  const saved = await copyToScans(asset.uri, filename);

  const extraction = isPdf ? await ladderFromPdf(saved.uri, deps) : await ladderFromImages([saved.uri], deps);
  const stem = asset.name.replace(/\.[^.]+$/, "").trim();
  const reference = extraction.bol_number || stem || defaultBolReference();
  const doc = await createBolDoc(
    db,
    reference,
    filename,
    "upload",
    1,
    extraction.vendor,
    extraction.po_number,
    extraction.ocr_text,
    extraction.line_items,
  );
  // Enqueue the single uploaded artifact for cloud storage (fire-and-forget; the
  // queue schedules its own retries and sets storage_url on success). Scan docs
  // (multi-page JPEGs) are NOT enqueued here — their single-artifact upload
  // awaits the deferred multi-page PDF assembly (see MISTRAL_PAGE1_NOTE above).
  if (doc) {
    const contentType = isPdf ? "application/pdf" : allowedImageContentType(asset.mimeType);
    if (contentType) void enqueueBolArtifact(db, doc.id, saved.uri, contentType);
  }
  return doc;
}

/**
 * The on-disk page-image URIs for a doc (scan docs only). Empty for upload docs
 * (a single PDF/image the detail view renders by filename).
 */
export function pageImageUrisForDoc(doc: BolDoc): string[] {
  const base = scanBaseFromFilename(doc.filename);
  return base ? pageUrisForBase(base, doc.pages) : [];
}

// -- React hook: load the Mistral key once ------------------------------------

/**
 * Loads the Mistral API key from `expo-secure-store` once on mount, returning
 * `{ key, ready }` so a screen can gate capture on `ready`.
 */
export function useMistralApiKey(): { key: string; ready: boolean } {
  const [key, setKey] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void (async () => {
      const { loadMistralApiKey } = await import("./mistralKey.js");
      setKey(await loadMistralApiKey());
      setReady(true);
    })();
  }, []);
  return { key, ready };
}
