/**
 * Better Auth server instance — the `effectivly` house style, adapted to this
 * repo's Drizzle-over-Turso stack.
 *
 * The instance is env-driven and built once per server process (memoized on a
 * `globalThis` stash so Next.js dev hot-reload reuses it). It uses Better
 * Auth's **built-in Kysely adapter** (NOT `@better-auth/drizzle-adapter`, which
 * peers on `drizzle-orm ^0.45` while this repo runs the `1.0.0-rc` line — the
 * same version reason `effectivly` cites), over a **separate** libSQL/Turso
 * auth database. Auth tables (user/session/account/verification) are owned by
 * Better Auth's own migrator (the root `auth.ts` CLI entrypoint + the
 * `auth:generate`/`auth:migrate` scripts) and live in that separate database —
 * they never enter `packages/domain`'s schema, so the field app never sees
 * them and the web app never becomes a second writer to the phone-synced Turso
 * database (multi-writer discipline, `plans/README.md`).
 *
 * Offline gate (same shape as `effectivly`): when `BETTER_AUTH_SECRET` is absent
 * there is no auth backend and {@link getAuth} returns `null` — the `/api/auth`
 * route then 404s and the {@link getUser} seam returns `null` (pages redirect to
 * `/sign-in`; the dev bypass, when active, short-circuits before this).
 * `AUTH_DATABASE_URL` defaults to a separate local dev file, so the gate keys
 * on the secret. When a live backend IS configured, `BETTER_AUTH_URL` is
 * required (the public origin OAuth callbacks and session cookies are built
 * against) — enforced at boot by the validated env schema (`@/lib/env`), so a
 * missing value fails loudly at boot rather than surfacing as an opaque
 * redirect mismatch later. Per the Better Auth guide, `secret`/`baseURL` are
 * NOT set in the config — Better Auth reads `BETTER_AUTH_SECRET`/
 * `BETTER_AUTH_URL` from the environment itself.
 *
 * All env reads go through the validated `@/lib/env` module — never raw
 * `process.env`.
 */

import { resolve } from "node:path";

import { betterAuth } from "better-auth";
import { LibsqlDialect } from "kysely-libsql";

import { env } from "@/lib/env";

/** Per-process stash so dev hot-reload reuses one Better Auth instance. */
const GLOBAL = globalThis as unknown as { __rfidWebAuth?: AuthInstance };

/** Default local auth database path (separate from the warehouse domain DB). */
const DEFAULT_LOCAL_AUTH_DB_PATH = "../../.dev-data/auth.db";

/**
 * Build the Kysely libSQL dialect for the auth database. Cloud path uses the
 * `AUTH_DATABASE_URL` (`libsql://...`) + `AUTH_DATABASE_AUTH_TOKEN`; when that is
 * unset the auth database defaults to a **separate** local dev file
 * (`LOCAL_AUTH_DB_PATH`, default `../../.dev-data/auth.db`) so auth tables never
 * share the warehouse domain database. The dialect is what Better Auth's
 * built-in adapter consumes (it wraps it in its own Kysely instance).
 */
function buildDialect(): { dialect: LibsqlDialect; url: string } {
  const url = env.AUTH_DATABASE_URL;
  if (url) {
    const authToken = env.AUTH_DATABASE_AUTH_TOKEN;
    return { url, dialect: new LibsqlDialect({ url, authToken }) };
  }
  const localPath = resolve(
    env.LOCAL_AUTH_DB_PATH ?? DEFAULT_LOCAL_AUTH_DB_PATH,
  );
  return { url: `file:${localPath}`, dialect: new LibsqlDialect({ url: `file:${localPath}` }) };
}

/**
 * Build the live Better Auth instance from the resolved environment, or
 * `null` when no auth backend is configured (the offline gate —
 * `BETTER_AUTH_SECRET` absent). `AUTH_DATABASE_URL` defaults to a local dev
 * file, so the gate keys on the secret: no secret → no auth backend. The
 * return type is inferred (not annotated) so {@link AuthInstance} captures the
 * concrete generic rather than the widened `Auth<BetterAuthOptions>` — the
 * latter's `$context` is incompatible with the real instance's options shape.
 * Conditional requirements (`BETTER_AUTH_URL` with the secret; the Entra tenant
 * with both Microsoft credentials) are enforced at boot by `@/lib/env`.
 */
export function createAuth() {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) {
    return null;
  }
  const baseURL = env.BETTER_AUTH_URL;
  // `env` already validated `baseURL` is present + a URL when `secret` is set,
  // but keep a defensive narrowing so the type is `string` (not `| undefined`).
  if (!baseURL) {
    return null;
  }
  const microsoftClientId = env.MICROSOFT_CLIENT_ID;
  const microsoftClientSecret = env.MICROSOFT_CLIENT_SECRET;
  const microsoftTenantId = env.MICROSOFT_TENANT_ID;
  const microsoft =
    microsoftClientId && microsoftClientSecret
      ? { clientId: microsoftClientId, clientSecret: microsoftClientSecret, tenantId: microsoftTenantId }
      : undefined;
  const { dialect } = buildDialect();
  // `secret` and `baseURL` are deliberately NOT passed here: Better Auth reads
  // them from the `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` env vars itself (the
  // Better Auth guide — only set these in config when the env vars are absent).
  return betterAuth({
    database: { dialect, type: "sqlite" },
    // SSO-only: Microsoft Entra ID is the sole sign-in method. Email/password
    // is left off (Better Auth's default), so there is no password surface.
    ...(microsoft
      ? {
          socialProviders: {
            microsoft: {
              clientId: microsoft.clientId,
              clientSecret: microsoft.clientSecret,
              tenantId: microsoft.tenantId,
              prompt: "select_account",
              // Entra's base64 photo can exceed HTTP header limits; never fetch it.
              disableProfilePhoto: true,
            },
          },
        }
      : {}),
    // SSO-only linking: every local user row is minted by Entra, so a matching
    // email IS that row's owner — trust it for implicit linking.
    account: {
      accountLinking: { trustedProviders: ["microsoft"] },
    },
    // Serve the principal from a short-lived signed cookie; one DB round-trip
    // per request becomes one per `maxAge` window.
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
  });
}

/**
 * The Better Auth instance, or `null` when no auth backend is configured.
 * Inferred from {@link createAuth} so it carries the concrete options generic.
 */
export type AuthInstance = ReturnType<typeof createAuth>;

/**
 * Get the shared Better Auth instance for this server process, building it on
 * first call. `null` when no auth backend is configured (offline). Server
 * components, the `/api/auth` route, and the {@link getUser} seam call this.
 */
export function getAuth(): AuthInstance {
  if (GLOBAL.__rfidWebAuth === undefined) {
    GLOBAL.__rfidWebAuth = createAuth();
  }
  return GLOBAL.__rfidWebAuth;
}

/** Whether a real auth backend is configured (vs. the offline `null` gate). */
export function isAuthEnabled(): boolean {
  return getAuth() !== null;
}

/** Whether Microsoft Entra ID SSO is wired (both client id + secret present). */
export function isMicrosoftEnabled(): boolean {
  return Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET);
}
