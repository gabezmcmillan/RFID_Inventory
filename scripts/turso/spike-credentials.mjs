// Plan 010, Phase 1 — Turso credential spike.
//
// Proves the server-side token model that the field app's secure sync relies on:
// the Vercel server holds a Platform API token and mints short-lived (minute
// TTL), fine-grained, single-database tokens; the libSQL server enforces them;
// expired/rotated tokens are rejected; and the installed
// @tursodatabase/sync-react-native invokes the async authToken callback per
// sync I/O so a refreshed token is used without reopening the database.
//
// Operator-run (not CI): needs a disposable Turso database + a Platform API
// token. The script mints/rotates/destroys only the disposable DB it is given.
// Never prints secret token values — only PASS/FAIL and decoded JWT *claims*.
//
// Env:
//   TURSO_PLATFORM_TOKEN  Platform API token (turso auth token)
//   TURSO_ORG             Organization slug owning the disposable DB
//   SPIKE_DB_NAME         Disposable database name (destroyed at the end)
//   SPIKE_DB_URL          libsql:// URL of the disposable database
//   CROSS_DB_URL          libsql:// URL of a second DB (cross-scope deny test)
//   SPIKE_TTL             Short-lived TTL for the expiry test (default "1m")
//   KEEP_DB               If "1", do not destroy the disposable DB at the end
//
// Exits 0 only if every check passes.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const webRequire = createRequire(resolve(process.cwd(), "apps/web/package.json"));
const fieldRequire = createRequire(resolve(process.cwd(), "apps/field/package.json"));
const { Kysely, sql } = webRequire("kysely");
const { LibsqlDialect } = webRequire("kysely-libsql");

const PLATFORM_TOK = process.env.TURSO_PLATFORM_TOKEN;
const ORG = process.env.TURSO_ORG;
const SPIKE = process.env.SPIKE_DB_NAME;
const SPIKE_URL = process.env.SPIKE_DB_URL;
const CROSS_DB_URL = process.env.CROSS_DB_URL;
const TTL = process.env.SPIKE_TTL || "1m";

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return process.env[name];
}

const results = [];
function check(name, cond) {
  results.push({ name, ok: cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
}

function db(url, tok) {
  return new Kysely({ dialect: new LibsqlDialect({ url, authToken: tok }) });
}

async function tryQuery(d, stmt) {
  try {
    await sql.raw(stmt).execute(d);
    return { ok: true, err: null };
  } catch (e) {
    return { ok: false, err: String(e.message).slice(0, 140) };
  }
}

// Mint a token via the Platform API. perm = array of {t,a} fine-grained rules
// (omit for full-access). Returns the JWT string.
async function mintToken(exp, perm) {
  const body = perm ? { fine_grained_permissions: perm } : {};
  const url = `https://api.turso.tech/v1/organizations/${ORG}/databases/${SPIKE}/auth/tokens?expiration=${exp}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${PLATFORM_TOK}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`mint ${exp} failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()).jwt;
}

function decodeClaims(jwt) {
  const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

// --- RN refresh-seam assertion: verify the INSTALLED artifact invokes the
// async authToken callback per HTTP I/O and applies it as the Bearer header.
// This is the JS-layer proof that a refreshed token is used on the next sync
// without reopening the database (the DB holds the callback; each I/O re-calls
// it). Faithful: reads the shipped compiled module, not a copy.
function assertRnRefreshSeam() {
  const pkg = "@tursodatabase/sync-react-native";
  const resolved = fieldRequire.resolve(`${pkg}/package.json`);
  const dir = resolve(resolved, "..");
  const io = readFileSync(resolve(dir, "lib/commonjs/internal/ioProcessor.js"), "utf8");
  const hasCallbackAwait = io.includes("await context.authToken()");
  const hasBearerInject = io.includes("Authorization'] = `Bearer ${authToken}`");
  const hasPerRequestCall = /await getAuthToken\(context\)/.test(io);
  check(
    "installed sync-react-native invokes async authToken callback per I/O (refresh without reopen)",
    hasCallbackAwait && hasBearerInject && hasPerRequestCall,
  );
}

async function main() {
  requireEnv("TURSO_PLATFORM_TOKEN");
  requireEnv("TURSO_ORG");
  requireEnv("SPIKE_DB_NAME");
  requireEnv("SPIKE_DB_URL");

  assertRnRefreshSeam();

  // 1. Mint a combined fine-grained + short-lived token and verify both claims.
  const perm = [
    { t: null, a: ["data_read"] },
    { t: ["spike_rows"], a: ["data_add", "data_update"] },
  ];
  const fgTok = await mintToken(TTL, perm);
  const claims = decodeClaims(fgTok);
  check("minted token carries fine-grained perm claim", Array.isArray(claims.perm));
  check("minted token carries an exp claim (short-lived)", typeof claims.exp === "number");
  const ttlMin = claims.exp ? (claims.exp - claims.iat) / 60 : 0;
  check(`token TTL ~${TTL} (${ttlMin.toFixed(1)} min)`, ttlMin > 0 && ttlMin <= 15);

  // 2. Set up the disposable schema with a full-access (never) token.
  const fullTok = await mintToken("never", null);
  const full = db(SPIKE_URL, fullTok);
  await sql.raw("CREATE TABLE IF NOT EXISTS spike_rows (id INTEGER PRIMARY KEY, val TEXT)").execute(full);
  await sql.raw("CREATE TABLE IF NOT EXISTS other_rows (id INTEGER PRIMARY KEY, val TEXT)").execute(full);
  await sql.raw("INSERT OR IGNORE INTO spike_rows (id, val) VALUES (1, 'seed')").execute(full);
  await sql.raw("INSERT OR IGNORE INTO other_rows (id, val) VALUES (1, 'seed')").execute(full);
  await full.destroy();

  // 3. Fine-grained enforcement with the short-lived token.
  const fg = db(SPIKE_URL, fgTok);
  check("read all (data_read) allowed", (await tryQuery(fg, "SELECT * FROM spike_rows")).ok);
  check("insert spike_rows (data_add) allowed", (await tryQuery(fg, "INSERT INTO spike_rows (id, val) VALUES (2, 'fg')")).ok);
  check("update spike_rows (data_update) allowed", (await tryQuery(fg, "UPDATE spike_rows SET val='fg2' WHERE id=2")).ok);
  check("delete spike_rows (data_delete) DENIED", !(await tryQuery(fg, "DELETE FROM spike_rows WHERE id=2")).ok);
  check("insert other_rows (no data_add) DENIED", !(await tryQuery(fg, "INSERT INTO other_rows (id, val) VALUES (2, 'fg')")).ok);
  check("schema_add (CREATE TABLE) DENIED", !(await tryQuery(fg, "CREATE TABLE not_allowed (id INTEGER)")).ok);
  check("schema_delete (DROP TABLE) DENIED", !(await tryQuery(fg, "DROP TABLE other_rows")).ok);
  check("schema_update (ALTER TABLE) DENIED", !(await tryQuery(fg, "ALTER TABLE spike_rows ADD COLUMN x TEXT")).ok);
  check("read sqlite_master (system data_read) allowed", (await tryQuery(fg, "SELECT name FROM sqlite_master WHERE type='table'")).ok);
  await fg.destroy();

  // 4. Cross-database scope: the spike token must not access another DB.
  if (CROSS_DB_URL) {
    const cross = db(CROSS_DB_URL, fgTok);
    check("cross-database access DENIED (token DB-scoped)", !(await tryQuery(cross, "SELECT 1")).ok);
    await cross.destroy();
  } else {
    console.log("SKIP: cross-database scope (CROSS_DB_URL not provided)");
  }

  // 5. Expiry: token works before, rejected after.
  const expDb = db(SPIKE_URL, fgTok);
  check("short-lived token works before expiry", (await tryQuery(expDb, "SELECT * FROM spike_rows")).ok);
  await expDb.destroy();
  const waitMs = Math.max(0, (claims.exp - Math.floor(Date.now() / 1000)) * 1000) + 4000;
  console.log(`waiting ${Math.round(waitMs / 1000)}s for token expiry...`);
  await new Promise((r) => setTimeout(r, waitMs));
  const expDb2 = db(SPIKE_URL, fgTok);
  check("short-lived token REJECTED after expiry", !(await tryQuery(expDb2, "SELECT * FROM spike_rows")).ok);
  await expDb2.destroy();

  // 6. Revocation: rotate keys, old token rejected.
  const revTok = await mintToken("1d", perm);
  const revDb = db(SPIKE_URL, revTok);
  check("token works before revocation", (await tryQuery(revDb, "SELECT * FROM spike_rows")).ok);
  await revDb.destroy();
  const rotateResp = await fetch(
    `https://api.turso.tech/v1/organizations/${ORG}/databases/${SPIKE}/auth/rotate`,
    { method: "POST", headers: { Authorization: `Bearer ${PLATFORM_TOK}` } },
  );
  check("rotate/invalidate keys accepted", rotateResp.ok);
  const revDb2 = db(SPIKE_URL, revTok);
  check("token REJECTED after key rotation (revocation)", !(await tryQuery(revDb2, "SELECT * FROM spike_rows")).ok);
  await revDb2.destroy();

  // 7. Destroy the disposable DB (unless KEEP_DB=1).
  if (process.env.KEEP_DB === "1") {
    console.log("KEEP_DB=1 — disposable DB left in place");
  } else {
    const del = await fetch(
      `https://api.turso.tech/v1/organizations/${ORG}/databases/${SPIKE}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${PLATFORM_TOK}` } },
    );
    check("disposable spike DB destroyed", del.ok);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nSPIKE RESULT: ${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("SPIKE ERROR:", e.message);
  process.exit(1);
});
