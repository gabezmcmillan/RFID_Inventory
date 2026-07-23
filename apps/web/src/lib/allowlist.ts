/**
 * Field-operator allowlist (plan 010, Phase 2). A server-only env setting
 * (`FIELD_OPERATOR_ALLOWLIST`) gates which signed-in users may link a field
 * device. Parsed from a comma- and/or whitespace-separated string of emails,
 * matched case-insensitively. An empty/absent allowlist denies everyone (the
 * link endpoints refuse), so a misconfigured deploy never silently allows
 * linking.
 */

/** Parse a raw allowlist string into a normalized set of lowercased emails. */
export function parseAllowlist(raw: string | undefined | null): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0 && s.includes("@")),
  );
}

/** Whether `email` is permitted to link a field device under the given allowlist. */
export function isAllowed(email: string | undefined | null, raw: string | undefined | null): boolean {
  if (!email) return false;
  const set = parseAllowlist(raw);
  if (set.size === 0) return false; // empty allowlist => deny all
  return set.has(email.trim().toLowerCase());
}
