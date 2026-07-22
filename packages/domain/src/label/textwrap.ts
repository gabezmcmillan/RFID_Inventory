/**
 * Faithful TypeScript port of CPython's `textwrap.wrap(text, width)` (v3.14),
 * used by {@link ../zpl.js}'s `descLayout` to estimate ZPL `^FB` greedy
 * word-wrap. Only the line count matters to `descLayout`, but the full
 * algorithm is ported so the wrap estimate can never diverge from Python's
 * `textwrap.wrap` on any ASCII description the app prints.
 *
 * Defaults match `textwrap.wrap`'s convenience call: `expand_tabs=True`,
 * `replace_whitespace=True`, `break_long_words=True`, `drop_whitespace=True`,
 * `break_on_hyphens=True`, `tabsize=8`, no `max_lines`, empty indents.
 *
 * The ASCII-only scope is deliberate: label field values are sanitized to
 * ASCII before reaching here, and Python's `re` is Unicode-aware for `\w`/
 * `[^\d\W]` only on non-ASCII input — which the printer path never produces.
 */

/** Python `_whitespace`: the US-ASCII whitespace class (tab, lf, vtab, ff, cr, space). */
const WHITESPACE = "\t\n\x0b\x0c\r ";
const WHITESPACE_CLASS = "[\\t\\n\\x0b\\x0c\\r ]";
const NON_WHITESPACE_CLASS = "[^\\t\\n\\x0b\\x0c\\r ]";
const WORD_PUNCT = "[\\w!\"'&.,?]";
const LETTER = "[^\\d\\W]";

/**
 * `str.expandtabs(tabsize)`: replace each tab with spaces to the next multiple
 * of `tabsize` (column-based, like Python).
 */
function expandTabs(text: string, tabsize = 8): string {
  if (!text.includes("\t")) return text;
  let out = "";
  for (const ch of text) {
    if (ch === "\t") {
      const pad = tabsize - (out.length % tabsize);
      out += " ".repeat(pad);
    } else {
      out += ch;
    }
  }
  return out;
}

/** `_munge_whitespace`: expand tabs, then translate every whitespace char to a single space. */
function mungeWhitespace(text: string): string {
  const expanded = expandTabs(text, 8);
  let out = "";
  for (const ch of expanded) {
    out += WHITESPACE.includes(ch) ? " " : ch;
  }
  return out;
}

/**
 * `TextWrapper._split` with `break_on_hyphens=True`: split text into word/
 * whitespace/hyphen chunks via `wordsep_re`. The capturing group is the whole
 * pattern, so `String.split` (which interleaves capturing groups, like Python's
 * `re.split`) yields the same chunk list; empties are dropped.
 */
const WORDSEP_RE = new RegExp(
  "(" +
    WHITESPACE_CLASS +
    "+" + // any whitespace
    "|(?<=" +
    WORD_PUNCT +
    ")-{2,}(?=\\w)" + // em-dash between words
    "|" +
    NON_WHITESPACE_CLASS +
    "+?(?:" + // word, possibly hyphenated (non-greedy)
    "-(?:(?<=" +
    LETTER +
    "{2}-)|(?<=" +
    LETTER +
    "-" +
    LETTER +
    "-))(?=" +
    LETTER +
    "-?" +
    LETTER +
    ")" + // hyphenated word break
    "|(?=" +
    WHITESPACE_CLASS +
    "|$)" + // end of word
    "|(?<=" +
    WORD_PUNCT +
    ")(?=-{2,}\\w)" + // em-dash
    "))",
  // No "u" flag: \w / [^\d\W] are ASCII, matching Python for ASCII input.
);

function splitChunks(text: string): string[] {
  return text.split(WORDSEP_RE).filter((c) => c.length > 0);
}

/** `TextWrapper._handle_long_word`: break a chunk too long for any line. */
function handleLongWord(
  stack: string[],
  curLine: string[],
  curLen: number,
  width: number,
): void {
  const spaceLeft = width < 1 ? 1 : width - curLen;
  if (spaceLeft < 1) return; // Python: only acts when there's room to place a piece
  const chunk = stack[stack.length - 1];
  if (chunk === undefined) return;
  // break_long_words is True; break_on_hyphens is True.
  let end = spaceLeft;
  if (chunk.length > spaceLeft) {
    // Python: chunk.rfind('-', 0, space_left) — last '-' within [0, space_left).
    // JS lastIndexOf('-', n) matches at index <= n, so pass space_left - 1.
    const hyphen = chunk.lastIndexOf("-", spaceLeft - 1);
    if (hyphen > 0 && chunk.slice(0, hyphen).split("").some((c) => c !== "-")) {
      end = hyphen + 1;
    }
  }
  curLine.push(chunk.slice(0, end));
  stack[stack.length - 1] = chunk.slice(end);
}

/** `TextWrapper._wrap_chunks` (defaults, no `max_lines`). */
function wrapChunks(chunks: string[], width: number): string[] {
  if (width <= 0) throw new Error(`invalid width ${width} (must be > 0)`);
  const lines: string[] = [];
  const stack = [...chunks].reverse();
  const peek = (): string | undefined => stack[stack.length - 1];

  while (stack.length > 0) {
    const curLine: string[] = [];
    let curLen = 0;
    const lineWidth = width; // empty indents

    // Drop a leading whitespace chunk on a non-first line.
    if (lines.length > 0 && peek()?.trim() === "") {
      stack.pop();
    }

    while (stack.length > 0) {
      const top = peek();
      if (top === undefined) break;
      if (curLen + top.length <= lineWidth) {
        curLine.push(top);
        curLen += top.length;
        stack.pop();
      } else {
        break;
      }
    }

    const top = peek();
    if (top !== undefined && top.length > lineWidth) {
      handleLongWord(stack, curLine, curLen, lineWidth);
      curLen = curLine.reduce((s, c) => s + c.length, 0);
    }

    // Drop a trailing whitespace chunk.
    const last = curLine[curLine.length - 1];
    if (last !== undefined && last.trim() === "") {
      curLen -= last.length;
      curLine.pop();
    }

    if (curLine.length > 0) {
      lines.push(curLine.join(""));
    } else if (stack.length === 0) {
      // All remaining was whitespace; nothing to do.
      break;
    }
    // curLine empty + stack non-empty: a long-word chunk that could not be
    // placed (spaceLeft was 0). Python leaves it for the next outer pass,
    // where cur_len is 0 and _handle_long_word breaks it. Loop again.
  }
  return lines;
}

/**
 * Port of `textwrap.wrap(text, width)`: greedy word-wrap with the defaults
 * documented above. Returns the list of wrapped lines (ASCII input).
 */
export function textwrapWrap(text: string, width: number): string[] {
  const munged = mungeWhitespace(text);
  const chunks = splitChunks(munged);
  return wrapChunks(chunks, width);
}
