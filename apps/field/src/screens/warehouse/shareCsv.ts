/**
 * Write a CSV string to the cache directory and open the iOS share sheet for
 * it (app.py:440-462). Uses expo-file-system's current `File`/`Paths` API and
 * `expo-sharing`'s `shareAsync`. The filename is timestamped like the Python
 * export (`inventory_YYYY-MM-DD_HHMM.csv`).
 */

import { File, Paths } from "expo-file-system";
import { shareAsync } from "expo-sharing";

/** Build the `inventory_YYYY-MM-DD_HHMM.csv` filename (mirrors app.py:457). */
export function csvFilename(prefix = "inventory"): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${prefix}_${stamp}.csv`;
}

/**
 * Write `csv` to a cache file and present the share sheet. Returns the file
 * URI (mostly for tests / diagnostics); throws if sharing is unavailable.
 */
export async function shareCsv(csv: string, filename = csvFilename()): Promise<string> {
  const file = new File(Paths.cache, filename);
  file.write(csv);
  await shareAsync(file.uri, {
    mimeType: "text/csv",
    UTI: "public.comma-separated-values-text",
    dialogTitle: "Export inventory",
  });
  return file.uri;
}
