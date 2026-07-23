import { describe, expect, test, vi } from "vitest";

/**
 * The new `@t3-oss/env-nextjs`-based `env` module must preserve the prior
 * hand-rolled parser's behavior: zero env vars works (offline dev gate), the
 * two cross-field conditional rules throw at module load, and a valid config
 * surfaces the parsed values. `createEnv` reads `runtimeEnv` (which maps to
 * `process.env`) at module-eval time, so each case sets `process.env`, resets
 * the module cache, and dynamic-imports `@/lib/env` fresh.
 */

async function importEnv(): Promise<typeof import("@/lib/env")> {
  vi.resetModules();
  return (await import("@/lib/env")) as typeof import("@/lib/env");
}

function clearAll(vars: string[]): void {
  for (const k of vars) delete process.env[k];
}

const ALL_VARS = [
  "NODE_ENV",
  "AUTH_DEV_BYPASS",
  "AUTH_DEV_BYPASS_NAME",
  "AUTH_DEV_BYPASS_EMAIL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "AUTH_DATABASE_URL",
  "AUTH_DATABASE_AUTH_TOKEN",
  "LOCAL_AUTH_DB_PATH",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "MICROSOFT_TENANT_ID",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "LOCAL_DB_PATH",
  "TURSO_MINT_TOKEN",
  "TURSO_ORG",
  "TURSO_DB_NAME",
  "FIELD_OPERATOR_ALLOWLIST",
  "BLOB_READ_WRITE_TOKEN",
];

describe("env (@t3-oss/env-nextjs)", () => {
  test("zero env vars => no throw, secret/url absent", async () => {
    clearAll(ALL_VARS);
    const { env } = await importEnv();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.BETTER_AUTH_URL).toBeUndefined();
    expect(env.BLOB_READ_WRITE_TOKEN).toBeUndefined();
  });

  test("BETTER_AUTH_SECRET without BETTER_AUTH_URL throws at load", async () => {
    clearAll(ALL_VARS);
    process.env.BETTER_AUTH_SECRET = "s3cr3t";
    await expect(importEnv()).rejects.toThrow(/BETTER_AUTH_URL/);
    delete process.env.BETTER_AUTH_SECRET;
  });

  test("BETTER_AUTH_SECRET with BETTER_AUTH_URL parses both", async () => {
    clearAll(ALL_VARS);
    process.env.BETTER_AUTH_SECRET = "s3cr3t";
    process.env.BETTER_AUTH_URL = "https://example.com";
    const { env } = await importEnv();
    expect(env.BETTER_AUTH_SECRET).toBe("s3cr3t");
    expect(env.BETTER_AUTH_URL).toBe("https://example.com");
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_URL;
  });

  test("Microsoft credentials without tenant throws at load", async () => {
    clearAll(ALL_VARS);
    process.env.MICROSOFT_CLIENT_ID = "cid";
    process.env.MICROSOFT_CLIENT_SECRET = "csec";
    await expect(importEnv()).rejects.toThrow(/MICROSOFT_TENANT_ID/);
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
  });

  test("a single Microsoft credential (no secret) does NOT require tenant", async () => {
    clearAll(ALL_VARS);
    process.env.MICROSOFT_CLIENT_ID = "cid";
    const { env } = await importEnv();
    expect(env.MICROSOFT_CLIENT_ID).toBe("cid");
    expect(env.MICROSOFT_TENANT_ID).toBeUndefined();
    delete process.env.MICROSOFT_CLIENT_ID;
  });

  test("empty-string BLOB_READ_WRITE_TOKEN is preserved as '' (not coerced to undefined)", async () => {
    clearAll(ALL_VARS);
    process.env.BLOB_READ_WRITE_TOKEN = "";
    const { env } = await importEnv();
    expect(env.BLOB_READ_WRITE_TOKEN).toBe("");
    delete process.env.BLOB_READ_WRITE_TOKEN;
  });
});
