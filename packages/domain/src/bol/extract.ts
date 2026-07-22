/**
 * BOL field extraction heuristics — a 1:1 TypeScript port of
 * `apps/warehouse/bol_extract.py`.
 *
 * Pure text functions: `extractFields(text, vendors)` finds labeled values
 * (same line beats the line below; an explicit NUMBER/NO/# word beats a bare
 * label; earlier lines win ties), `cleanValue` rejects date-shaped and
 * non-ID tokens and strips OCR-glued letter runs after digits, a "P.O. Box"
 * is guarded out, a PO identical to the BOL keeps the BOL only, and
 * `matchVendor` matches the vendor only against the known vendors table
 * (exact word-boundary or fuzzy window ratio ≥ 0.8, with a +0.1 hint-word
 * bonus) so OCR noise can never invent a new vendor.
 *
 * The fuzzy ratio is a `difflib.SequenceMatcher`-style ratio (2·matches /
 * total length via longest-common-substring recursion) — see
 * {@link sequenceRatio}. The test fixtures under `__fixtures__/` define
 * correctness.
 */

/**
 * An "ID-looking" token: starts alphanumeric, then letters/digits/-/. up to 24
 * chars, and must contain at least one digit somewhere (rejects DATE, PREPAID,
 * column headers, …). Source of {@link ID_TOKEN}.
 */
const ID_TOKEN_SRC = String.raw`(?=[A-Za-z0-9\-/.]{0,23}\d)[A-Za-z0-9][A-Za-z0-9\-/.]{2,23}`;

/** Compiled {@link ID_TOKEN_SRC}. */
/** A date-shaped value (rejected by {@link cleanValue}). */
const DATE_SHAPE = /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/;

/** The optional explicit-number word after a label (NUMBER/NBR/NUM/NO/#). */
const NUM_WORD = String.raw`(?:NUMBER|NBR|NUM|NO\.?|#)`;

/**
 * The BOL label. The word-boundary guards keep `BL` out of `BLOCK` and `BOL`
 * out of `BOLSTER` (a label word must not run into another word).
 */
const BOL_LABEL_SRC = String.raw`(?<![A-Za-z0-9])(?:BILL\s*OF\s*LADING|B\s*/\s*B|B\.L\.?|BOL|BL)(?![A-Za-z])`;

/** The PO label. `P.O. Box` is later guarded out via `not_followed_by`. */
const PO_LABEL_SRC = String.raw`(?<![A-Za-z0-9])(?:PURCHASE\s*ORDER|CUST(?:OMER)?\.?\s*ORDER|CUST(?:OMER)?\.?\s*P\.?\s*O\.?|P\.?\s*O\.?|P/O)(?![A-Za-z])`;

/** `label + optional NUMBER/NO/# + separator` — the shared head for both match styles. */
function labelHead(labelSrc: string): string {
  return String.raw`${labelSrc}\s*(?:${NUM_WORD})?\s*[:#=]*\s*`;
}

/** The extracted-fields result shape (all "" when not found). */
export interface ExtractedFields {
  bol_number: string;
  po_number: string;
  vendor: string;
}

/**
 * Trim trailing punctuation and reject non-ID shapes ("" if rejected).
 *
 * OCR often drops the space after a number, gluing the next word onto it
 * ("79299Shipper", "429660PO"); a 2+ letter run straight after a digit is
 * such an artifact, not part of the ID, and is stripped. A date-shaped value
 * (next to "BOL DATE") is rejected.
 */
export function cleanValue(raw: string | null | undefined): string {
  let value = (raw ?? "").trim().replace(/^[.,;:/-]+|[.,;:/-]+$/g, "");
  // Strip a 2+ letter run glued straight after a digit.
  value = value.replace(/(?<=\d)[A-Za-z]{2,}$/, "");
  if (value.length < 3 || !/[0-9]/.test(value)) return "";
  if (DATE_SHAPE.test(value)) return "";
  return value;
}

/** One labeled-value candidate: the value, its line index, and its score. */
interface LabeledCandidate {
  value: string;
  index: number;
  score: number;
}

/**
 * Best ID value for a label across all lines (bol_extract.py `_find_labeled_value`).
 *
 * Returns `[value, lineIndex]` or `["", -1]`. Same-line matches outrank
 * below-line matches; an explicit NUMBER/NO/# word outranks a bare label;
 * earlier lines win ties (these numbers live at the top of the form).
 */
function findLabeledValue(
  lines: readonly string[],
  labelSrc: string,
  notFollowedBy = "",
): [value: string, index: number] {
  const head = labelHead(labelSrc);
  const guard = notFollowedBy ? String.raw`(?!${notFollowedBy})` : "";
  const sameLine = new RegExp(String.raw`${head}${guard}(${ID_TOKEN_SRC})`, "i");
  const headerOnly = new RegExp(String.raw`^${head}$`, "i");
  const hasNumWord = new RegExp(String.raw`${labelSrc}\s*${NUM_WORD}`, "i");

  let best: LabeledCandidate = { value: "", index: -1, score: 0 };
  for (let idx = 0; idx < lines.length; idx++) {
    const line = (lines[idx] ?? "").trim();
    if (!line) continue;
    let score = 0;
    let value = "";
    const m = sameLine.exec(line);
    if (m) {
      const cleaned = cleanValue(m[1]);
      if (cleaned) {
        value = cleaned;
        score = 2.0;
      }
    }
    if (!value && headerOnly.test(line)) {
      // Value is the first ID-looking token on the next non-empty line.
      for (let n = idx + 1; n <= idx + 2 && n < lines.length; n++) {
        const nxt = (lines[n] ?? "").trim();
        if (!nxt) continue;
        const first = nxt.split(/\s+/)[0] ?? "";
        const fullIdToken = new RegExp(`^${ID_TOKEN_SRC}$`);
        if (fullIdToken.test(first)) {
          const cleaned = cleanValue(first);
          if (cleaned) {
            value = cleaned;
            score = 1.0;
          }
        }
        break;
      }
    }
    if (!value) continue;
    if (hasNumWord.test(line)) score += 0.5;
    if (score > best.score) best = { value, index: idx, score };
  }
  return [best.value, best.index];
}

// -- vendor -------------------------------------------------------------------

/** Lowercased labels near which a vendor match earns a small bonus. */
const VENDOR_HINTS = ["vendor", "shipper", "supplier", "ship from", "from", "sold by"];

/** Trailing company suffixes stripped to derive a vendor's "printed" variant. */
const COMPANY_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company",
]);

/** Fuzzy window ratio a vendor variant must clear to count as a match. */
const FUZZY_THRESHOLD = 0.8;

/** Normalize a string for vendor matching: lowercase, collapse non-alnum to spaces, trim. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/**
 * Normalized forms to try for a vendor name: the full name, and the name minus
 * trailing company suffixes ("Acme Corp" is usually printed as just "ACME").
 */
function vendorVariants(name: string): string[] {
  const full = norm(name);
  const variants: string[] = [];
  if (full) variants.push(full);
  const words = full.split(" ");
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[words.length - 1] ?? "")) {
    words.pop();
  }
  const stripped = words.join(" ");
  if (stripped && stripped !== full && stripped.length >= 4) variants.push(stripped);
  return variants;
}

/**
 * A `difflib.SequenceMatcher`-style similarity ratio: `2·matches / total`,
 * where `matches` is the total length of matching blocks found by repeated
 * longest-common-substring recursion (mirrors `difflib`'s
 * `get_matching_blocks` for the short strings vendor names are).
 */
export function sequenceRatio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1.0;
  let matches = 0;
  const recurse = (alo: number, ahi: number, blo: number, bhi: number): void => {
    const [i, j, k] = longestCommonSubstring(a, b, alo, ahi, blo, bhi);
    if (k === 0) return;
    matches += k;
    recurse(alo, i, blo, j);
    recurse(i + k, ahi, j + k, bhi);
  };
  recurse(0, a.length, 0, b.length);
  return (2.0 * matches) / total;
}

/**
 * Longest common substring within `a[alo..ahi)` / `b[blo..bhi)`, returned as
 * `[i, j, k]` (start in a, start in b, length). Ties break to the smallest `i`,
 * then the smallest `j` (matches `difflib.find_longest_match` for short input).
 */
function longestCommonSubstring(
  a: string,
  b: string,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): [i: number, j: number, k: number] {
  let bestI = alo;
  let bestJ = blo;
  let bestK = 0;
  // prev[j] = length of the longest common substring ending at b[j-1] from the previous a row.
  let prev = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const cur = new Map<number, number>();
    const ai = a[i];
    for (let j = blo; j < bhi; j++) {
      if (b[j] !== ai) continue;
      const len = (prev.get(j - 1) ?? 0) + 1;
      cur.set(j, len);
      if (len > bestK) {
        bestK = len;
        bestI = i - len + 1;
        bestJ = j - len + 1;
      }
    }
    prev = cur;
  }
  return [bestI, bestJ, bestK];
}

/**
 * Best matching known vendor in the text ("" if none clears the bar).
 *
 * Exact word-boundary hits beat fuzzy ones; being on / right under a
 * Vendor/Shipper/From-style label adds a small bonus. The vendor is only ever
 * one of the names already in `vendors` — OCR noise can never invent a new one.
 */
export function matchVendor(text: string, vendors: readonly string[] = []): string {
  const names = vendors.filter((v) => (v ?? "").trim() !== "");
  if (names.length === 0) return "";
  const lines = text.split(/\r?\n/).map(norm);
  let bestName = "";
  let bestScore = 0.0;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!line) continue;
    const nearHint =
      lines
        .slice(Math.max(0, idx - 2), idx + 1)
        .some((l) => VENDOR_HINTS.some((hint) => l.includes(hint)));
    const words = line.split(" ");
    for (const name of names) {
      for (const variant of vendorVariants(name)) {
        let score = 0.0;
        if (` ${line} `.includes(` ${variant} `)) {
          score = 1.0;
        } else if (variant.length >= 4) {
          const n = variant.split(" ").length;
          for (let i = 0; i <= words.length - n; i++) {
            const window = words.slice(i, i + n).join(" ");
            const ratio = sequenceRatio(variant, window);
            if (ratio > score) score = ratio;
          }
          if (score < FUZZY_THRESHOLD) score = 0.0;
        }
        if (!score) continue;
        if (nearHint) score += 0.1;
        if (score > bestScore || (score === bestScore && name.length > bestName.length)) {
          bestName = name;
          bestScore = score;
        }
      }
    }
  }
  return bestName;
}

// -- public entry point -------------------------------------------------------

/**
 * Parse OCR text into `{bol_number, po_number, vendor}` guesses.
 *
 * Every value is "" when not found; callers fall back to their existing
 * defaults (timestamp reference, blank form fields).
 */
export function extractFields(text: string, vendors: readonly string[] = []): ExtractedFields {
  const result: ExtractedFields = { bol_number: "", po_number: "", vendor: "" };
  if (!(text ?? "").trim()) return result;
  const lines = text.split(/\r?\n/);

  const [bol] = findLabeledValue(lines, BOL_LABEL_SRC);
  // "P.O. Box 12345" is an address; require the PO label not be followed by BOX.
  // A PO value identical to the BOL value is a shared "BOL/PO" line — keep it as the BOL only.
  let [po] = findLabeledValue(lines, PO_LABEL_SRC, String.raw`BOX\b`);
  if (po && bol && po.toLowerCase() === bol.toLowerCase()) po = "";
  result.bol_number = bol;
  result.po_number = po;
  result.vendor = matchVendor(text, vendors);
  return result;
}
