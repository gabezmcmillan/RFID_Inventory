// Plan 010, Phase 3 — two-replica convergence proof.
//
// The RN embedded-replica sync engine (@tursodatabase/sync-react-native) is
// RN-only, so the true local-file <-> remote-primary push/pull convergence
// can't be exercised in Node/CI. This script proves the DATA-level
// convergence semantics the coordinator depends on — unique inserts from two
// replicas converge to the union, and concurrent same-row edits resolve to
// last-push-wins in BOTH push orders — using the HTTP libSQL client (via
// kysely-libsql, same seam as the Phase 1 spike) against a disposable shared
// primary. The physical embedded-replica push/pull path remains
// physical-device-only (see the manual checklist in the decision doc).
//
// Operator-run (not CI): needs a disposable Turso DB + a full-access token.
// Never prints the token value — only PASS/FAIL.
//
// Env:
//   CONV_DB_URL    libsql:// URL of the disposable database
//   CONV_DB_TOKEN   full-access token for that database
//
// Exits 0 only if every check passes.
import { createRequire } from "node:module";
import { resolve } from "node:path";

const webRequire = createRequire(resolve(process.cwd(), "apps/web/package.json"));
const { Kysely, sql } = webRequire("kysely");
const { LibsqlDialect } = webRequire("kysely-libsql");

const URL = process.env.CONV_DB_URL;
const TOK = process.env.CONV_DB_TOKEN;
if (!URL || !TOK) {
  console.error("Missing CONV_DB_URL / CONV_DB_TOKEN");
  process.exit(2);
}

const results = [];
function check(name, cond) {
  results.push({ name, ok: cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
}

function replica() {
  return new Kysely({ dialect: new LibsqlDialect({ url: URL, authToken: TOK }) });
}

async function reset(d) {
  await sql.raw("DROP TABLE IF EXISTS conv_rows").execute(d);
  await sql
    .raw("CREATE TABLE conv_rows (id TEXT PRIMARY KEY, val TEXT, by TEXT, ts INTEGER)")
    .execute(d);
}

async function readAll(d) {
  const r = await sql.raw("SELECT id, val FROM conv_rows ORDER BY id").execute(d);
  const map = new Map();
  for (const row of r.rows) {
    map.set(row.id, row.val);
  }
  return map;
}

async function runOrder(first) {
  const a = replica();
  const b = replica();
  await reset(a);
  // Each replica writes its own unique row + the shared row 's'.
  // first === "A": A pushes s=A (ts=1), then B pushes s=B (ts=2) => last-push-wins = B.
  // first === "B": B pushes s=B (ts=1), then A pushes s=A (ts=2) => last-push-wins = A.
  const expectedShared = first === "A" ? "B" : "A";
  const firstClient = first === "A" ? a : b;
  const secondClient = first === "A" ? b : a;
  const second = first === "A" ? "B" : "A";
  await sql
    .raw(`INSERT OR REPLACE INTO conv_rows (id, val, by, ts) VALUES ('s', '${first}', '${first}', 1)`)
    .execute(firstClient);
  await sql
    .raw(`INSERT INTO conv_rows (id, val, by, ts) VALUES ('${first.toLowerCase()}1', 'u-${first}', '${first}', 1)`)
    .execute(firstClient);
  await sql
    .raw(`INSERT OR REPLACE INTO conv_rows (id, val, by, ts) VALUES ('s', '${second}', '${second}', 2)`)
    .execute(secondClient);
  await sql
    .raw(`INSERT INTO conv_rows (id, val, by, ts) VALUES ('${second.toLowerCase()}1', 'u-${second}', '${second}', 2)`)
    .execute(secondClient);

  const view = await readAll(a);
  check(`order ${first}->other: unique inserts converge (3 rows)`, view.size === 3);
  check(`order ${first}->other: a1 present`, view.has("a1"));
  check(`order ${first}->other: b1 present`, view.has("b1"));
  check(
    `order ${first}->other: shared row = last-pushed (${expectedShared})`,
    view.get("s") === expectedShared,
  );
  await a.destroy();
  await b.destroy();
}

async function main() {
  await runOrder("A");
  await runOrder("B");
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nCONVERGENCE RESULT: ${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("CONVERGENCE ERROR:", e?.message ?? String(e));
  process.exit(1);
});
