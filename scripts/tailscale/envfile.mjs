// Pure helpers for reading/upserting a single KEY=value pair in a dotenv-style
// file content string. No Node platform side effects, no npm deps — safe to
// unit-test with fixtures. Used by `tailscale.mjs` to upsert
// `EXPO_PUBLIC_DEFAULT_SERVER_URL` into `apps/field/.env.local` while preserving
// comments and other values, and by doctor to read it back.

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read the value of `key` from dotenv `content`. Returns the unquoted, trimmed
 * value, or `null` when the key is absent (or only present in a commented-out
 * line). Does NOT parse interpolation or multiline values.
 */
export function readEnvKey(content, key) {
  if (typeof content !== "string" || !key) return null;
  const re = new RegExp(`^\\s*${escapeRe(key)}\\s*=(.*)$`);
  for (const line of content.split("\n")) {
    if (re.test(line)) {
      let val = line.replace(re, "$1").trim();
      // Strip a single layer of matching surrounding quotes.
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      return val;
    }
  }
  return null;
}

/**
 * Return `content` with `key` set to `value`, preserving every other line
 * (including comments and blank lines) and the original trailing-newline state.
 * Updates an existing active `key=` line in place (preserving its leading
 * whitespace and key spacing up to `=`); otherwise appends a new `key=value`
 * line. Commented-out copies of the key are NOT touched (a new active line is
 * appended). Never echoes anything; the caller controls all output.
 */
export function upsertEnvKey(content, key, value) {
  if (!key) return content;
  const lines = content.length === 0 ? [] : content.split("\n");
  const re = new RegExp(`^\\s*${escapeRe(key)}\\s*=`);
  const found = lines.findIndex((l) => re.test(l));
  if (found >= 0) {
    const eq = lines[found].indexOf("=");
    const prefix = lines[found].slice(0, eq + 1); // up to and including '='
    lines[found] = `${prefix}${value}`;
    return lines.join("\n");
  }
  // Append a new active line, preserving the existing trailing-newline state.
  if (lines.length === 0) {
    return `${key}=${value}`;
  }
  if (lines[lines.length - 1] === "") {
    // content ended with "\n" — insert before the trailing empty element.
    lines.splice(lines.length - 1, 0, `${key}=${value}`);
    return lines.join("\n");
  }
  lines.push(`${key}=${value}`);
  return lines.join("\n");
}
