import { describe, expect, test } from "vitest";

import { buildDbOpts, resolveEffectiveMode, type DbCredSource } from "@/db/dbMode";

/** A fake credential source with a controllable cached URL. */
function fakeCred(url: string | null): DbCredSource {
  return {
    syncUrl: url,
    getSyncToken: async () => "tok",
  };
}

describe("db mode — unlinked opens local-only (startup-crash regression)", () => {
  test("resolveEffectiveMode downgrades a synced request to local when no URL", () => {
    expect(resolveEffectiveMode("local", false)).toBe("local");
    expect(resolveEffectiveMode("local", true)).toBe("local");
    expect(resolveEffectiveMode("synced", false)).toBe("local");
    expect(resolveEffectiveMode("synced", true)).toBe("synced");
  });

  test("local mode never constructs sync options (no url/authToken/bootstrapIfEmpty)", () => {
    const opts = buildDbOpts("inventory.db", "local", fakeCred(null));
    expect(opts).toEqual({ path: "inventory.db" });
    expect("url" in opts).toBe(false);
    expect("authToken" in opts).toBe(false);
    expect("bootstrapIfEmpty" in opts).toBe(false);
  });

  test("a synced request with no URL still opens local-only (the reported crash)", () => {
    // The provider requests "synced" when linked, but if the credential fetch
    // failed (offline) syncUrl is null — the effective mode downgrades to
    // local, so the opts carry NO sync options and the native engine is never
    // asked for an HTTP request with no URL.
    const effective = resolveEffectiveMode("synced", false);
    expect(effective).toBe("local");
    const opts = buildDbOpts("inventory.db", effective, fakeCred(null));
    expect(opts).toEqual({ path: "inventory.db" });
    expect("url" in opts).toBe(false);
  });

  test("synced mode with a URL constructs the full sync options", () => {
    const cred = fakeCred("libsql://warehouse.example.turso.io");
    const opts = buildDbOpts("inventory.db", "synced", cred);
    expect(opts.path).toBe("inventory.db");
    expect(typeof opts.url).toBe("function");
    expect(typeof opts.authToken).toBe("function");
    expect(opts.bootstrapIfEmpty).toBe(true);
    // The url callback returns the cached, non-null URL.
    expect((opts.url as () => string | null)()).toBe("libsql://warehouse.example.turso.io");
  });

  test("the synced url callback never returns null while synced (primed guarantee)", async () => {
    const cred = fakeCred("libsql://warehouse.example.turso.io");
    const opts = buildDbOpts("inventory.db", "synced", cred);
    const urlFn = opts.url as () => string | null;
    expect(urlFn()).toBe("libsql://warehouse.example.turso.io");
    const tokenFn = opts.authToken as () => Promise<string>;
    expect(await tokenFn()).toBe("tok");
  });
});
