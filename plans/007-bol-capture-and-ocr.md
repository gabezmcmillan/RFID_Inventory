# Plan 007: BOL capture with the camera + OCR field extraction

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79443fb..HEAD -- apps/warehouse/bol_extract.py apps/warehouse/ocr_mistral.py apps/warehouse/app.py packages/domain apps/field`
> If `bol_extract.py` or `ocr_mistral.py` changed since `79443fb`, compare
> the excerpts below against the live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (extraction quality is empirical; the design keeps every value operator-correctable)
- **Depends on**: plans/004-field-app-foundation-and-checkin.md
- **Category**: migration
- **Planned at**: commit `79443fb`, 2026-07-22

## Why this matters

Check-in starts with the truck's bill of lading. Today an Epson ES-50 +
NAPS2 + Tesseract scan it at a desk; the phone replaces all three with its
camera (VisionKit document capture) and keeps the same intelligence: BOL #,
PO # and Vendor are extracted automatically and prefill the shipment form as
editable guesses, and every box checked in links back to the document. The
extraction ladder is: **Mistral OCR (online, primary) → on-device OCR + the
ported heuristics (offline fallback) → operator types it (always available)**
— same guarantees as the Python app: extraction may be empty, never wrong-by
-invention (the vendor is only ever matched against the vendors table).

## Current state

- Check-in (plan 004) has a manual BOL Number field and passes `bol_doc_id`
  through `intakeSession` when present (`apps/warehouse/intake.py:32-38,161`).
- Domain has `createBolDoc`, `getBolDoc`, `listBolDocs`, `renameBolDoc`,
  `deleteBolDoc`, `applyBolExtraction`, `setBolDocPages` (plan 002), and the
  `bol_docs` table with `storage_url` (empty until plan 010 wires uploads).

Behavioral spec from Python:

**Document lifecycle** (`apps/warehouse/app.py:604-706`, db.py:505-673): a
capture creates a `bol_docs` row whose `bol_number` is the OCR guess or a
placeholder `"BOL 07-07 3:12PM"` (`_default_bol_reference`, app.py:572-576),
flagged `auto_named=1` until the operator renames it (rename also updates
tags already filed under it, db.py:596-623). "Add page" re-runs extraction
over the whole document and fills only what's still empty; the BOL number is
replaced only while still `auto_named` (`apply_bol_extraction`,
db.py:632-673). Docs list shows newest-first with linked box counts.

**Mistral extraction** (`apps/warehouse/ocr_mistral.py`): one POST to
`https://api.mistral.ai/v1/ocr`, model `mistral-ocr-latest`, with the
document and a JSON-schema **document annotation** requesting
`{bol_number, po_number, vendor, items[{item_no, item_name, quantity}]}` —
the schema's field descriptions double as extraction instructions (lines
48-119; port them verbatim). The prompt (lines 121-128) plus a "Known
vendors (prefer the matching one…)" suffix (lines 135-141). Post-processing
(lines 189-235): `_clean` treats "none"/"n/a"/etc. as empty; a PO equal to
the BOL keeps only the BOL; **the vendor answer is re-matched against the
vendors table** via `match_vendor` — never used verbatim; line items drop
entries without an item_no, dedupe case-insensitively, cap at 30, and
normalize quantity to a positive-int string ("700.00" → "700"). Any failure →
null → fall back to local. Timeout 45 s.

**Local heuristics** (`apps/warehouse/bol_extract.py`): pure text functions —
`extract_fields(text, vendors)` finds labeled values (same line beats the
line below; explicit NUMBER/NO/# beats a bare label; earlier lines win ties),
`_clean_value` rejects date-shaped and non-ID tokens and strips OCR-glued
letter runs after digits, "P.O. Box" is guarded out, PO==BOL keeps BOL only,
and `match_vendor` does exact word-boundary or fuzzy (window ratio ≥ 0.8)
matching against known vendors with a +0.1 bonus near
vendor/shipper/from-style hint words. Port this file 1:1; for the fuzzy
ratio implement a `SequenceMatcher`-style ratio (2·matches/total length via
longest-common-substring recursion) — the test fixtures below define
correctness.

**Check-in integration** (README "Check In", app.js behavior): check-in's
setup phase starts with the document step — capture / pick-a-recent-doc /
skip; extracted fields prefill `bol_number`, `po_number`, `vendor`
(editable); extracted `line_items` render as one-tap chips that prefill the
per-unit Item No./Item Name/Quantity fields during the scanning phase.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm -r typecheck` | exit 0 |
| Domain tests | `pnpm --filter @rfid/domain test` | all pass |
| Bundle check | `pnpm --filter @rfid/field exec expo export --platform ios` | exit 0 |

## Scope

**In scope**:
- `packages/domain/src/bol/**` (heuristics port + Mistral client + fixtures)
- `apps/field/src/bol/**` (capture, on-device OCR, document store) and the
  check-in document step; `app/bol-docs.tsx` (documents list/detail)
- Settings: `mistral_api_key` field (stored in `expo-secure-store`)
- root `pnpm-lock.yaml`

**Out of scope**:
- Blob upload of documents to the cloud (`storage_url` stays empty; plan 010).
- NAPS2/Epson support of any kind.
- `apps/warehouse/**` — reference only.

## Git workflow

- Branch: `advisor/007-bol-capture-ocr`
- Commit per step, short imperative messages (repo style).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Port the heuristics into the domain package

`packages/domain/src/bol/extract.ts`: port `bol_extract.py` — `extractFields
(text, vendors)`, `matchVendor(text, vendors)`, `cleanValue`, the label
regexes (translate Python named groups/lookbehinds to JS regex; JS supports
lookbehind). Create fixtures under `src/bol/__fixtures__/`: at least four
synthetic OCR texts covering (a) same-line `BOL NO: 123456789`, (b)
table-header layout (label line, value on next line), (c) a `P.O. Box 12345`
trap plus a real `PO # 44821`, (d) a date next to "BOL DATE" that must be
rejected, plus vendor cases: exact match, suffix-stripped ("Acme Corp" text
"ACME"), fuzzy ≥0.8, and below-0.8 → "". Assert PO==BOL collapses to BOL
only.

**Verify**: `pnpm --filter @rfid/domain test` → all pass.

### Step 2: Mistral OCR client in the domain package

`packages/domain/src/bol/mistral.ts`: `extractFieldsViaMistral({apiKey,
document, vendors, fetchImpl})` — port `ocr_mistral.py`: the annotation
schema and prompt verbatim (lines 48-128), the request body (document as a
`data:` URL — support both `application/pdf` and `image/jpeg` documents,
Mistral's `/v1/ocr` accepts `document_url` and `image_url` types; use
`image_url` for single JPEGs and `document_url` for PDFs), 45 s timeout via
`AbortController`, and the full post-processing of lines 179-244 (`_clean`,
PO==BOL, `matchVendor` re-matching with the `"vendor: <model answer>"`
prefix trick of line 196-197, `_clean_items`). Return `null` on any failure.

Vitest with a stubbed `fetchImpl`: happy path parses a canned response body;
model vendor "ACME Corporation" re-matches to the table's "Acme Corp";
"P.O. Box"-free guarantee (PO==BOL case); network error → null; malformed
annotation JSON → still returns markdown-based result shape with heuristic
vendor.

**Verify**: `pnpm --filter @rfid/domain test` → all pass.

### Step 3: Capture + on-device OCR in the field app

- Add `react-native-document-scanner-plugin` (VisionKit edge-detected
  capture; returns per-page JPEG URIs) and
  `@react-native-ml-kit/text-recognition` (on-device OCR for the offline
  fallback). Both need a dev build — bundling and typecheck remain the CI
  gate.
- `apps/field/src/bol/documentStore.ts`: saves captured pages under
  `FileSystem.documentDirectory + "scans/"` as `bol_YYYYMMDD_HHMMSS_pN.jpg`
  (collision-free naming mirroring app.py:561-569), creates/updates the
  `bol_docs` row (`source: "scan"`, `pages`, filename = first page), and
  runs the extraction ladder:
  1. If a Mistral key is set and the device is online → step 2's client
     (all pages; multi-page JPEGs sent as separate requests with merged
     markdown is NOT the Python behavior — build one PDF from the JPEGs via
     `expo-print`'s `printToFileAsync` HTML wrapper OR send page 1 only;
     choose **page 1 only** and record the limitation in the doc row's
     `ocr_text` header comment — STOP condition if this proves contentious).
  2. Else → MLKit `recognize()` per page, join text, run
     `extractFields(text, vendors)`.
  Results go through `applyBolExtraction` semantics for adds / the create
  path for new docs (placeholder reference from `_default_bol_reference`
  port when no BOL found).
- "Upload" fallback: `expo-document-picker` for an existing PDF/image (source
  `"upload"`), same ladder.

**Verify**: `pnpm -r typecheck` → exit 0; `expo export` → exit 0.

### Step 4: Check-in integration + documents screen

- Check-in setup phase gains the document step: [Scan BOL] [Recent docs ▾]
  [Skip]. On capture/pick: show extracted BOL/PO/Vendor as prefilled editable
  fields (vendor only prefills when it matched the table), stash
  `bol_doc_id` into the armed fields, and offer "Add page" (append capture →
  re-extract → `applyBolExtraction`).
- Scanning phase: if the doc carries `line_items`, render them as chips;
  tapping one sets Item No./Item Name/Quantity via
  `intakeSession.setItemFields`.
- `app/bol-docs.tsx`: newest-first list (`listBolDocs(0)`) with box counts,
  detail view = page images + rename (updates linked tags — show the
  returned count) + delete (admin PIN, from plan 006's gate).
- Warehouse group rows (plan 006) link to the doc detail when `bol_doc_id`
  is set.

**Verify**: `pnpm -r typecheck` → exit 0; simulator: skip-path check-in still
works (no regression); with a fake key and stubbed fetch in dev tools,
capture → prefill → check in → drill-down shows the box linked to the doc.

## Test plan

- Steps 1–2 carry the substance: heuristics fixtures (≥10 assertions) and the
  Mistral client suite (5 cases). Model after plan 002's repo tests.
- Real-document extraction quality is tuned post-cutover with actual BOLs —
  the ladder guarantees a wrong guess is one tap to fix.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @rfid/domain test` exits 0 incl. `bol/` suites
- [ ] `pnpm -r typecheck` exits 0
- [ ] `pnpm --filter @rfid/field exec expo export --platform ios` exits 0
- [ ] `grep -rn "match_vendor\|matchVendor" packages/domain/src/bol/mistral.ts` ≥ 1 (vendor never trusted verbatim)
- [ ] `grep -rn "naps2\|epson\|es-50" -i apps/field packages/domain` → no matches
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Either native package (`react-native-document-scanner-plugin`,
  `@react-native-ml-kit/text-recognition`) is incompatible with the current
  Expo SDK — report versions and the error; do not swap in a different
  scanner library without recording it.
- The Mistral `/v1/ocr` request shape rejects `image_url` documents — verify
  against current Mistral docs and report what the API actually accepts.
- Multi-page extraction (page-1-only decision in step 3) is deemed
  insufficient during review — the PDF-assembly alternative needs a decision,
  not improvisation.
- Porting the fuzzy ratio can't satisfy a fixture — report the case; adjust
  the fixture only with justification, never the 0.8 threshold silently.

## Maintenance notes

- Extraction quality tuning lives in two places only: the annotation
  schema/prompt (`packages/domain/src/bol/mistral.ts`) and the heuristics
  fixtures. A reviewer should reject prompt edits without fixture updates.
- `storage_url` is written by plan 010's upload queue; the docs screen should
  already render a cloud icon when it's non-empty (cheap now, needed then).
- Deferred: full-page OCR text search across documents; multi-page Mistral
  extraction (see step 3 decision).
