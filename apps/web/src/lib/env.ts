/**
 * Typed, schema-validated environment — the single place `process.env` is read
 * in `apps/web`. Mirrors the `effectivly` house style (one declared schema, raw
 * `process.env` reads anywhere else are an anti-pattern) but uses zod instead
 * of Effect's `Config`, since this repo has no Effect dependency. Like
 * `effectivly`'s `AppConfig`, a missing/malformed variable fails loudly at
 * module load (boot) with one message listing every problem — never a silent
 * `undefined` halfway through a request.
 *
 * Edge-safe: this module imports only `zod` and reads `process.env` (both
 * available in the Next.js Edge Runtime), so the proxy (`src/proxy.ts`) can
 * import it via `dev-bypass.ts` without dragging in `node:path` /
 * `kysely-libsql` / `betterAuth` (none of which the Edge Runtime can load).
 *
 * Server vs client vars are separated: server vars are parsed from `process.env`
 * directly; client vars (`NEXT_PUBLIC_*`) are parsed from the same source but
 * surfaced through a separate `clientEnv` object so client bundles never see a
 * secret. There are no `NEXT_PUBLIC_*` vars today — the empty client schema
 * keeps the seam in place for the first one.
 *
 * Offline gate (unchanged behavior): `BETTER_AUTH_SECRET` is OPTIONAL — when it
 * is absent there is no auth backend and `auth.ts`'s `getAuth()` returns `null`
 * (the `/api/auth` route 404s, `getUser()` returns `null`, pages redirect to
 * `/sign-in`, and the dev bypass short-circuits before any of that). So the dev
 * path still works with ZERO env vars set. The only "required" vars are
 * CONDITIONAL, enforced by `superRefine` exactly as the prior code did:
 *   - `BETTER_AUTH_URL` is required when `BETTER_AUTH_SECRET` is set.
 *   - `MICROSOFT_TENANT_ID` is required when BOTH `MICROSOFT_CLIENT_ID` and
 *     `MICROSOFT_CLIENT_SECRET` are set (a single one of the pair is treated as
 *     "not configured", matching the prior `clientId && clientSecret` shape —
 *     Entra's `common` fallback would otherwise accept any Microsoft account).
 * The Entra ID vars themselves stay OPTIONAL so the dev-bypass path works
 * without them.
 */

import { z } from "zod";

/** Server-only variables. Secrets live here; never re-exported to a client. */
const serverSchema = z
  .object({
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
    // Field device API origin — the SEPARATELY NAMED, typed origin embedded in
    // the device-link QR and used for field API/sync traffic. It is NEVER
    // Better Auth's `baseURL` (which stays localhost); it is the private
    // Tailscale HTTPS origin (or an approved reserved ngrok fallback). Its
    // Development value is local-only/per-developer and is NOT Vercel-managed.
    FIELD_DEVICE_API_ORIGIN: z.string().url().optional(),
    FIELD_DEVICE_API_TRANSPORT: z.enum(["tailscale", "ngrok"]).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.BETTER_AUTH_SECRET && !val.BETTER_AUTH_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_URL"],
        message:
          "BETTER_AUTH_URL must be set alongside BETTER_AUTH_SECRET — it is this app's public origin for OAuth callbacks and session cookies.",
      });
    }
    // The device API origin must be distinct from the web/SSO origin: it can
    // never replace Better Auth's canonical localhost base URL.
    if (val.FIELD_DEVICE_API_ORIGIN && val.BETTER_AUTH_URL) {
      const deviceOrigin = val.FIELD_DEVICE_API_ORIGIN.replace(/\/+$/, "");
      const betterOrigin = val.BETTER_AUTH_URL.replace(/\/+$/, "");
      if (deviceOrigin === betterOrigin) {
        ctx.addIssue({
          code: "custom",
          path: ["FIELD_DEVICE_API_ORIGIN"],
          message:
            "FIELD_DEVICE_API_ORIGIN must differ from BETTER_AUTH_URL — the device API origin can never be the web/SSO origin.",
        });
      }
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

/** Client-exposed variables (`NEXT_PUBLIC_*`). Empty today. */
const clientSchema = z.object({});

type ServerEnv = z.infer<typeof serverSchema>;
type ClientEnv = z.infer<typeof clientSchema>;

/**
 * Parse a schema against `process.env`, throwing one clear, grep-able message
 * on failure that lists every issue (so a partial config surfaces all problems
 * at once instead of one-at-a-time).
 */
function parseEnv<T>(schema: z.ZodType<T>, label: string): T {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(
      `Invalid ${label} configuration (set in .env.local / deployment env):\n${lines.join("\n")}`,
    );
  }
  return parsed.data;
}

/** The validated server environment — read this, never raw `process.env`. */
export const env: ServerEnv = parseEnv(serverSchema, "server");

/** The validated client environment (`NEXT_PUBLIC_*`). Empty today. */
export const clientEnv: ClientEnv = parseEnv(clientSchema, "client");
