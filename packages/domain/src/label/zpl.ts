/**
 * ZPL label builder — a pure-TypeScript port of `apps/warehouse/printer.py`'s
 * `print_label` + `LABEL_ZPL` + `QR_ZPL` + `_desc_layout` + `_zpl_safe`. The
 * field template is reproduced byte-for-byte (positions were iterated against
 * the Labelary renderer and verified on the physical Zebra ZD621R); the golden
 * fixture (`__fixtures__/label-basic.zpl`) is generated from the Python source
 * so any drift is caught.
 *
 * Two settings deliberately absent (printer.py:17-24): no label-length command
 * (media calibration governs length) and no RFID program-position / write-power
 * command (RFID calibration lives in the printer). Do not add them.
 */

import { textwrapWrap } from "./textwrap.js";

/** Label could not be built; the message is safe to show the operator. */
export class PrintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrintError";
  }
}

/** A standard 96-bit EPC is exactly 24 uppercase hex characters. */
const EPC_HEX = /^[0-9A-F]{24}$/;

/** Description block width in dots (printer.py `DESC_WIDTH`). */
const DESC_WIDTH = 740;
/** Average glyph advance relative to ^A0 font height (printer.py `DESC_CHAR_W`). */
const DESC_CHAR_W = 0.55;
/** (font height in dots, max lines) tiers the description steps down through. */
const DESC_TIERS: ReadonlyArray<{ readonly font: number; readonly maxLines: number }> = [
  { font: 66, maxLines: 2 },
  { font: 50, maxLines: 3 },
  { font: 40, maxLines: 4 },
];

/** Result of {@link descLayout}: the chosen font, line cap, and text to print. */
export interface DescLayout {
  readonly font: number;
  readonly maxLines: number;
  readonly text: string;
}

/** Input parameters for {@link buildLabelZpl}; mirrors `printer.print_label`. */
export interface BuildLabelZplParams {
  readonly epc: string;
  readonly building?: string;
  readonly sector?: string;
  readonly description?: string;
  readonly supplier?: string;
  readonly sku?: string;
  readonly quantity?: string;
  readonly poNumber?: string;
  readonly receivedDate?: string;
  readonly receivedTime?: string;
  readonly qrUrl?: string;
}

/**
 * Neutralize ZPL control characters (`^` `~`) and control codes (0x00-0x1f,
 * 0x7f) in field data, then trim — port of `printer._zpl_safe`. Each matched
 * char becomes a single space (Python `re.sub(...)`), then `.strip()`.
 */
function zplSafe(value: string | undefined | null): string {
  const s = value || "";
  return s.replace(/[\^~\x00-\x1f\x7f]/g, " ").trim();
}

/**
 * Pick `(font, maxLines, text)` so `text` fits the description block — port of
 * `printer._desc_layout`. Largest tier that holds the whole text wins, using a
 * greedy word-wrap estimate ({@link textwrapWrap} ≡ Python `textwrap.wrap`).
 * If even the smallest tier overflows, the text is cut at its last full line
 * with a trailing `"..."` rather than letting ^FB overprint the last line.
 */
export function descLayout(text: string): DescLayout {
  for (const t of DESC_TIERS) {
    const perLine = Math.trunc(DESC_WIDTH / (t.font * DESC_CHAR_W));
    if (textwrapWrap(text, perLine).length <= t.maxLines) {
      return { font: t.font, maxLines: t.maxLines, text };
    }
  }
  // Smallest tier (the last): ellipsis-trim until the text fits.
  const smallest = DESC_TIERS[DESC_TIERS.length - 1];
  if (!smallest) throw new Error("DESC_TIERS must not be empty");
  const perLine = Math.trunc(DESC_WIDTH / (smallest.font * DESC_CHAR_W));
  let remaining = text;
  while (remaining.length > 0) {
    const candidate = remaining.replace(/[ .]+$/, "") + "...";
    if (textwrapWrap(candidate, perLine).length <= smallest.maxLines) {
      return { font: smallest.font, maxLines: smallest.maxLines, text: candidate };
    }
    remaining = remaining.slice(0, -1);
  }
  return { font: smallest.font, maxLines: smallest.maxLines, text: "..." };
}

/**
 * Build one 4×6 label's ZPL and encode `epc` into its RFID inlay — port of
 * `printer.print_label` minus the `_send` side effect. Validates the EPC
 * (uppercase, exactly 24 hex) and sanitizes every field value. The QR block is
 * included only when `qrUrl` is non-empty. Returns the ZPL string ending in
 * `^XZ\n` (the trailing newline is part of the template).
 */
export function buildLabelZpl(params: BuildLabelZplParams): string {
  const epc = (params.epc || "").toUpperCase();
  if (!EPC_HEX.test(epc)) {
    throw new PrintError(`Bad EPC for encoding (need 24 hex chars): '${epc}'`);
  }
  const qrUrl = params.qrUrl || "";
  const qr = qrUrl ? `^FO950,1150^BQN,2,6^FDQA,${zplSafe(qrUrl)}^FS\n` : "";
  const desc = descLayout(zplSafe(params.description));
  const building = zplSafe(params.building);
  const sector = zplSafe(params.sector);
  const supplier = zplSafe(params.supplier);
  const sku = zplSafe(params.sku);
  const quantity = zplSafe(params.quantity);
  const poNumber = zplSafe(params.poNumber);
  const receivedDate = zplSafe(params.receivedDate);
  const receivedTime = zplSafe(params.receivedTime);
  return (
    "^XA\n" +
    "^PW1218\n" +
    `^FO0,70^A0N,300,300^FB1218,1,0,C^FDATL ${building}^FS\n` +
    `^FO0,380^A0N,150,150^FB1218,1,0,C^FDSector: ${sector}^FS\n` +
    "^FO70,570^GB1078,4,4^FS\n" +
    "^FO70,640^A0N,46,46^FDDESCRIPTION^FS\n" +
    `^FO440,630^A0N,${desc.font},${desc.font}^FB740,${desc.maxLines},0,L^FD${desc.text}^FS\n` +
    "^FO70,830^A0N,46,46^FDSUPPLIER^FS\n" +
    `^FO440,820^A0N,66,66^FB740,1,0,L^FD${supplier}^FS\n` +
    "^FO70,1020^A0N,46,46^FDITEM NO.^FS\n" +
    `^FO440,1010^A0N,66,66^FB740,1,0,L^FD${sku}^FS\n` +
    "^FO70,1210^A0N,46,46^FDQTY^FS\n" +
    `^FO440,1200^A0N,66,66^FD${quantity}^FS\n` +
    "^FO70,1400^A0N,46,46^FDPO #^FS\n" +
    `^FO440,1390^A0N,66,66^FD${poNumber}^FS\n` +
    "^FO70,1590^A0N,46,46^FDRECEIVED^FS\n" +
    `^FO440,1580^A0N,66,66^FDDate: ${receivedDate}^FS\n` +
    `^FO440,1670^A0N,66,66^FDTime: ${receivedTime}^FS\n` +
    `${qr}^RFW,H^FD${epc}^FS\n` +
    "^XZ\n"
  );
}
