/**
 * Typed, schema-validated environment — the single place `process.env` is read
 * in `apps/web`. Mirrors the `effectivly` house style (one declared schema, raw
 * `process.env` reads anywhere else are an anti-pattern) but uses zod via
 * `@t3-oss/env-nextjs`'s `createEnv` (the standard Next.js env helper) instead of
 * a hand-rolled parser. Like `effectivly`'s `AppConfig`, a missing/malformed
 * variable fails loudly at module load (boot) with one message listing every
 * problem — never a silent `undefined` halfway through a request.
 *
 * Edge-safe: `@t3-oss/env-nextjs` imports only zod and reads `process.env` (both
 * available in the Next.js Edge Runtime), so the proxy (`src/proxy.ts`) can
 * import it via `dev-bypass.ts` without dragging in `node:path` /
 * `kysely-libsql` / `betterAuth` (none of which the Edge Runtime can load).
 *
 * Server vs client vars are separated: server vars are declared in the `server`
 * record; client vars (`NEXT_PUBLIC_*`) in the `client` record so client
 * bundles never see a secret. There are no `NEXT_PUBLIC_*` vars today — the
 * empty client record keeps the seam in place for the first one (and `clientEnv`
 * stays an empty export for shape compatibility).
 *
 * Cross-field rules (BETTER_AUTH_URL required with BETTER_AUTH_SECRET; Microsoft
 * tenant required with both Microsoft credentials) can't live on a per-field
 * schema, so the combined schema is built via `createFinalSchema` with a
 * `superRefine` — exactly the conditional rules the prior hand-rolled parser
 * enforced.
 *
 * Offline gate (unchanged behavior): `BETTER_AUTH_SECRET` is OPTIONAL — when it
 * is absent there is no auth backend and `auth.ts`'s `getAuth()` returns `null`
 * (the `/api/auth` route 404s, `getUser()` returns `null`, pages redirect to
 * `/sign-in`, and the dev bypass short-circuits before any of that). So the dev
 * path still works with ZERO env vars set. The only "required" vars are
 * CONDITIONAL, enforced by the `superRefine` below:
 *   - `BETTER_AUTH_URL` is required when `BETTER_AUTH_SECRET` is set.
 *   - `MICROSOFT_TENANT_ID` is required when BOTH `MICROSOFT_CLIENT_ID` and
 *     `MICROSOFT_CLIENT_SECRET` are set (a single one of the pair is treated as
 *     "not configured", matching the prior `clientId && clientSecret` shape —
 *     Entra's `common` fallback would otherwise accept any Microsoft account).
 * The Entra ID vars themselves stay OPTIONAL so the dev-bypass path works
 * without them.
 */

import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Per-field server schemas. A plain `ZodRawShape` (record of zod schemas) —
 * `createEnv`'s `server` takes a `StandardSchemaDictionary`, which zod v4
 * schemas satisfy (zod v4 is standard-schema compliant). Cross-field rules
 * can't go here (each field is validated in isolation); they live in
 * {@link finalSchema}'s `superRefine`.
 */
const serverShape = {
  NODE_ENV: z.string().optional(),
  // Dev bypass — grep-able, impossible to enable in production (the
  // `NODE_ENV !== "production"` guard lives next to the read in dev-bypass.ts
  // so the proxy can short-circuit without importing this module's throw).
  AUTH_DEV_BYPASS: z.string().optional(),
  AUTH_DEV_BYPASS_NAME: z.string().optional(),
  AUTH_DEV_BYPASS_EMAIL: z.string().optional(),
  // Better Auth offline gate — absent secret => no auth backend.
  BETTER_AUTH_SECRET: z.string().min(1).optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  // Separate auth database (Kysely/libSQL). Absent => local dev file below.
  AUTH_DATABASE_URL: z.string().optional(),
  AUTH_DATABASE_AUTH_TOKEN: z.string().optional(),
  LOCAL_AUTH_DB_PATH: z.string().optional(),
  // Microsoft Entra ID SSO — all optional; conditional rules below.
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().optional(),
  // Warehouse domain database (Drizzle/Turso). Absent => local dev file below.
  TURSO_DATABASE_URL: z.string().optional(),
  TURSO_AUTH_TOKEN: z.string().optional(),
  LOCAL_DB_PATH: z.string().optional(),
  // Plan 010: server-only Turso Platform API token used to mint short-lived,
  // fine-grained database tokens for field devices. NEVER exposed to a client
  // (no NEXT_PUBLIC_/EXPO_PUBLIC_ prefix). Broad `all` scope today (the CLI
  // user is not an org admin); see docs/operations/sync-security-decision.md
  // for the tradeoff + rotation note.
  TURSO_MINT_TOKEN: z.string().optional(),
  // Turso Platform API targets for minting field-device sync tokens: the
  // organization name + database NAME (as in `turso db list`), NOT the libSQL
  // hostname. Server-only.
  TURSO_ORG: z.string().optional(),
  TURSO_DB_NAME: z.string().optional(),
  // Plan 010: server-only allowlist of operator emails permitted to link a
  // field device. Comma- and/or whitespace-separated, case-insensitive.
  FIELD_OPERATOR_ALLOWLIST: z.string().optional(),
  // Plan 010: server-only Vercel Blob read-write token for the `rfid-bol` store.
  // Used only by the BOL upload proxy to write page artifacts; never exposed to a
  // client (no NEXT_PUBLIC_/EXPO_PUBLIC_ prefix).
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
} satisfies Record<string, z.ZodType>;

/**
 * The combined schema with the cross-field conditional rules the prior
 * hand-rolled parser enforced. `createEnv` runs this at module load, so a
 * violated rule fails loudly at boot with the issue message.
 */
const finalSchema = z
  .object(serverShape)
  .superRefine((val, ctx) => {
    if (val.BETTER_AUTH_SECRET && !val.BETTER_AUTH_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_URL"],
        message:
          "BETTER_AUTH_URL must be set alongside BETTER_AUTH_SECRET — it is this app's public origin for OAuth callbacks and session cookies.",
      });
    }
    // Mirror the prior `clientId && clientSecret` shape: only when BOTH are
    // present is Entra considered configured, and then the tenant is required.
    if (val.MICROSOFT_CLIENT_ID && val.MICROSOFT_CLIENT_SECRET) {
      if (!val.MICROSOFT_TENANT_ID) {
        ctx.addIssue({
          code: "custom",
          path: ["MICROSOFT_TENANT_ID"],
          message:
            "MICROSOFT_TENANT_ID is required when Microsoft credentials are configured — without it Entra's `common` endpoint would accept any Microsoft account, including personal ones.",
        });
      }
    }
  });

/** The validated environment — read this, never raw `process.env`. */
export const env = createEnv({
  server: serverShape,
  client: {},
  // `createEnv` requires an explicit `runtimeEnv` mapping every declared var to
  // its `process.env` source (it does not read `process.env` directly, so it
  // stays tree-shakeable + edge-safe). Optional vars are simply `undefined`
  // when unset, which the optional schema accepts.
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    AUTH_DEV_BYPASS: process.env.AUTH_DEV_BYPASS,
    AUTH_DEV_BYPASS_NAME: process.env.AUTH_DEV_BYPASS_NAME,
    AUTH_DEV_BYPASS_EMAIL: process.env.AUTH_DEV_BYPASS_EMAIL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    AUTH_DATABASE_URL: process.env.AUTH_DATABASE_URL,
    AUTH_DATABASE_AUTH_TOKEN: process.env.AUTH_DATABASE_AUTH_TOKEN,
    LOCAL_AUTH_DB_PATH: process.env.LOCAL_AUTH_DB_PATH,
    MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
    MICROSOFT_TENANT_ID: process.env.MICROSOFT_TENANT_ID,
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
    LOCAL_DB_PATH: process.env.LOCAL_DB_PATH,
    TURSO_MINT_TOKEN: process.env.TURSO_MINT_TOKEN,
    TURSO_ORG: process.env.TURSO_ORG,
    TURSO_DB_NAME: process.env.TURSO_DB_NAME,
    FIELD_OPERATOR_ALLOWLIST: process.env.FIELD_OPERATOR_ALLOWLIST,
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
  },
  // Apply the cross-field conditional rules on top of the per-field schemas.
  createFinalSchema: () => finalSchema,
  // Preserve the prior hand-rolled parser's error ergonomics: throw one clear,
  // grep-able message listing every issue (path + message) instead of t3-env's
  // generic "Invalid environment variables", so a partial config surfaces all
  // problems at once at boot.
  onValidationError: (issues) => {
    const lines = issues.map((i) => {
      const path = (i.path ?? [])
        .map((p) => (typeof p === "object" && p !== null && "key" in p ? String(p.key) : String(p)))
        .join(".");
      return `  - ${path || "(root)"}: ${i.message}`;
    });
    throw new Error(
      `Invalid server configuration (set in .env.local / deployment env):\n${lines.join("\n")}`,
    );
  },
  // Preserve the prior behavior: an empty string is NOT coerced to undefined
  // (e.g. the BOL upload proxy treats `BLOB_READ_WRITE_TOKEN=""` as "not
  // configured" => 503, the same as absent).
  emptyStringAsUndefined: false,
});

/**
 * The validated client environment (`NEXT_PUBLIC_*`). Empty today — kept as an
 * export so the seam is in place for the first client var without churning
 * callers.
 */
export const clientEnv: Record<string, never> = {};
