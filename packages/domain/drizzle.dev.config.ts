import { defineConfig } from "drizzle-kit";

/**
 * Drizzle-kit config for applying the warehouse domain migrations to a REMOTE
 * Turso database out-of-band (the web app's serverless path does not run
 * migrations — see `apps/web/src/lib/db.ts`). Used by the dev-provisioning
 * script to migrate `rfid-warehouse-dev` (and reusable for any remote warehouse
 * DB, e.g. production cutover):
 *
 *   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... \
 *     pnpm --filter @rfid/domain exec drizzle-kit migrate --config drizzle.dev.config.ts
 *
 * Credentials come from the environment (never committed). The migration
 * journal (`__drizzle_migrations`) is the same one the React-Native-safe
 * `applyMigrations` runner uses, so the remote and on-device paths stay in
 * lockstep. `schema`/`out` mirror `drizzle.config.ts` so this config applies
 * the exact same checked-in migrations.
 *
 * `dialect: "turso"` is REQUIRED for a remote libSQL/Turso database: it routes
 * drizzle-kit to its Turso-remote connection path, which creates the libSQL
 * client WITH `authToken`. With `dialect: "sqlite"` drizzle-kit instead uses
 * the generic SQLite path that omits the auth token, so every request 401s
 * against the remote DB even though the credentials are correct. (`turso` is a
 * dialect, not a `driver`; the sqlite `driver` enum is d1-http/expo/etc.)
 */
export default defineConfig({
  dialect: "turso",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
});
