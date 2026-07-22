/**
 * TSL ASCII 2.0 line tokenizing and classification.
 *
 * The reader streams ASCII lines terminated by `\r\n` (or bare `\n`). This
 * module turns a raw byte/string stream into complete lines and classifies
 * each into one of the protocol's line kinds. It is a pure-TypeScript port of
 * the parsing in `apps/warehouse/reader.py` (`_handle_line`, `_parse_rssi`).
 */

/** Discriminated union of classified reader lines. */
export type ReaderLine =
  | { readonly kind: "ep"; readonly epc: string }
  | { readonly kind: "ri"; readonly rssi: number }
  | { readonly kind: "sw"; readonly state: string }
  | { readonly kind: "ok" }
  | { readonly kind: "er" }
  | { readonly kind: "other"; readonly raw: string };

/**
 * Splits an incoming byte/string stream into complete lines, holding any
 * trailing partial line for the next push. Handles both `\r\n` and bare `\n`
 * terminators (the reader's `readline` reads to `\n`; commands use `\r\n`).
 */
export class LineTokenizer {
  private _carry = "";

  /** Append a chunk and return the complete lines it produced. */
  push(chunk: string): string[] {
    this._carry += chunk;
    const lines: string[] = [];
    let idx = this._carry.indexOf("\n");
    while (idx !== -1) {
      let line = this._carry.slice(0, idx);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      lines.push(line);
      this._carry = this._carry.slice(idx + 1);
      idx = this._carry.indexOf("\n");
    }
    return lines;
  }

  /** Drop any buffered partial line (e.g. on disconnect). */
  clear(): void {
    this._carry = "";
  }
}

/**
 * Parse an `RI:` payload into a signed dBm integer, or `null` if unparseable.
 * Mirrors `reader.py:_parse_rssi`: first token, try decimal then hex, else
 * ignore.
 */
export function parseRssi(payload: string): number | null {
  const trimmed = payload.trim();
  if (trimmed === "") {
    return null;
  }
  const token = trimmed.split(/\s+/)[0] ?? "";
  const dec = Number.parseInt(token, 10);
  if (Number.isInteger(dec)) {
    return dec;
  }
  const hex = Number.parseInt(token, 16);
  if (Number.isInteger(hex)) {
    return hex;
  }
  return null;
}

/**
 * Classify a complete reader line into a {@link ReaderLine}. Returns `null`
 * for an `RI:` line whose payload does not parse (matching `reader.py`, which
 * silently ignores unparseable RSSI). EPCs are uppercased.
 */
export function classifyLine(line: string): ReaderLine | null {
  if (line.startsWith("EP:")) {
    const epc = line.slice(3).trim().toUpperCase();
    if (epc === "") {
      return { kind: "other", raw: line };
    }
    return { kind: "ep", epc };
  }
  if (line.startsWith("RI:")) {
    const rssi = parseRssi(line.slice(3));
    if (rssi === null) {
      return null;
    }
    return { kind: "ri", rssi };
  }
  if (line.startsWith("SW:")) {
    return { kind: "sw", state: line.slice(3).trim().toLowerCase() };
  }
  if (line.startsWith("OK:")) {
    return { kind: "ok" };
  }
  if (line.startsWith("ER:")) {
    return { kind: "er" };
  }
  return { kind: "other", raw: line };
}
