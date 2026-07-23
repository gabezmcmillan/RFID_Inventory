// Verify the Vercel-managed dev Turso databases are reachable and list their
// tables (names only — never values). Uses kysely-libsql (the same LibsqlDialect
// path apps/web/src/lib/auth.ts uses), so it exercises the real app connection.
//
// Loads credentials from apps/web/.env.local itself (parses + strips one pair
// of surrounding quotes), so it does not depend on shell sourcing and never
// prints secrets.
//
// Usage: pnpm --filter @rfid/web exec tsx ../../scripts/verify-dev-db.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the app's direct deps (kysely, kysely-libsql) from apps/web, since
// this script lives in scripts/ (repo root) and bare imports would otherwise
// resolve from the script's own directory. Same LibsqlDialect path auth.ts uses.
const webRoot = resolve(fileURLToPath(import.meta.url), "../../apps/web");
const webRequire = createRequire(resolve(webRoot, "package.json"));
const { Kysely, sql } = webRequire("kysely");
const { LibsqlDialect } = webRequire("kysely-libsql");

const envPath = resolve(webRoot, ".env.local");
const env = new Map();
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  if (line.startsWith("#") || line.trim() === "") continue;
  const eq = line.indexOf("=");
  if (eq <= 0) continue;
  let v = line.slice(eq + 1);
  // Strip one pair of surrounding quotes (dotenv / vercel env pull behavior).
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    v = v.slice(1, -1);
  }
  env.set(line.slice(0, eq).trim(), v);
}

async function listTables(label, urlVar, tokVar) {
  const url = env.get(urlVar);
  const authToken = env.get(tokVar);
  if (!url) {
    console.log(`${label}: ${urlVar} not set — skipping.`);
    return null;
  }
  const host = url.replace(/^libsql:\/\//, "").split("/")[0];
  console.log(`${label} | host: ${host} | urlLen: ${url.length} | tokLen: ${authToken?.length ?? 0} | tokHasQuote: ${authToken?.[0] === '"'}`);
  const db = new Kysely({ dialect: new LibsqlDialect({ url, authToken }) });
  try {
    const res = await sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`.execute(db);
    const names = res.rows.map((r) => r.name).filter(Boolean);
    console.log(`  tables (${names.length}): ${names.join(", ") || "(none)"}`);
    return names;
  } catch (e) {
    console.log(`  ERROR: ${String(e.message).slice(0, 160)} | code: ${e.code}`);
    return null;
  } finally {
    await db.destroy();
  }
}

await listTables("warehouse", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN");
await listTables("auth", "AUTH_DATABASE_URL", "AUTH_DATABASE_AUTH_TOKEN");
