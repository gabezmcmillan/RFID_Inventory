/**
 * Drizzle driver adapter for `@tursodatabase/sync-react-native`.
 *
 * As of drizzle-orm 1.0.0-rc.4 there is no React Native Turso driver, and the
 * Node `drizzle({ client })` factory (`drizzle-orm/tursodatabase/database`)
 * transitively imports `@tursodatabase/database`, whose entry is a NAPI-RS
 * native-addon loader (`node:module` / `node:fs` / `child_process` + a `.node`
 * binding) — unusable in a React Native bundle. So that factory cannot be used
 * on-device.
 *
 * Instead we build the Drizzle database from the RN-safe Turso internals
 * (`SQLiteDialect` + `TursoDatabaseSession` + `TursoDatabaseDatabase`), which
 * are pure JS and pull no native code, and hand the session an adapter that
 * presents the on-device `@tursodatabase/sync-react-native` `Database` as the
 * `DatabasePromise` client the session expects. The RN client's `Statement` has
 * no array/`.raw(bool)` mode and returns object rows keyed by column name, so
 * the adapter's `Statement` shim derives array rows via `Object.values` —
 * SQLite and the RN binding preserve the query's column order in object keys,
 * and Drizzle's arrays-mode mappers read by column index, which matches that
 * order. The RN `Database.transaction(fn)` returns a `Promise` directly, but Drizzle
 * calls `client.transaction(fn)()` (a callable), so the adapter returns a thunk.
 *
 * One cast is unavoidable: `DatabasePromise` has private members, so the
 * adapter is not structurally assignable. It is isolated to a single line at
 * the driver boundary (`as unknown as TursoClient`) and documented here.
 *
 * CONSTRAINT (see plans/README.md standing decisions): because array rows are
 * derived from object rows, a builder query whose SELECT list contains
 * duplicate column names (e.g. an un-aliased join selecting two `id` columns)
 * would collapse duplicates and misalign columns. No domain query joins tables
 * today; any future builder join must select explicitly aliased columns.
 *
 * TODO: replace when drizzle ships an official React Native Turso driver.
 */

import { SQLiteDialect } from "drizzle-orm/sqlite-core/dialect";
import { TursoDatabaseDatabase } from "drizzle-orm/tursodatabase/driver-core";
import { TursoDatabaseSession } from "drizzle-orm/tursodatabase/session";
import type {
  BindParams,
  Database as TursoRnDatabase,
  Row,
  RunResult,
  SQLiteValue,
  Statement as RnStatement,
} from "@tursodatabase/sync-react-native";

import type { DomainDb } from "@rfid/domain";

/** The `DatabasePromise`-shaped client `TursoDatabaseSession` expects. */
type TursoClient = ConstructorParameters<typeof TursoDatabaseSession>[0];

/**
 * A prepared-statement shim over the RN `Statement` adding the `.raw(bool)`
 * mode toggle Drizzle's session calls. Arrays mode (`.raw(true)`) returns rows
 * as arrays of column values in query order (via `Object.values`); objects mode
 * (`.raw(false)`) returns rows as-is, keyed by column name — the two modes
 * Drizzle's prepared-query path usres.
 */
class TursoRnStatement {
  private arrays = false;

  constructor(private readonly stmt: RnStatement) {}

  /** Toggle arrays mode (Drizzle calls `stmt.raw(mode === "arrays")`). */
  raw(arrays: boolean): this {
    this.arrays = arrays;
    return this;
  }

  async all(...params: BindParams[]): Promise<Row[] | SQLiteValue[][]> {
    const rows = await this.stmt.all(...params);
    return this.arrays ? rows.map((r) => Object.values(r)) : rows;
  }

  async get(...params: BindParams[]): Promise<Row | SQLiteValue[] | undefined> {
    const row = await this.stmt.get(...params);
    if (row === undefined) return undefined;
    return this.arrays ? Object.values(row) : row;
  }

  async run(...params: BindParams[]): Promise<RunResult> {
    return this.stmt.run(...params);
  }
}

/**
 * Adapts the on-device Turso `Database` to the `DatabasePromise` client
 * surface Drizzle's Turso session calls (`prepare` / `all` / `get` / `run` /
 * `transaction`).
 */
class TursoRnClient {
  constructor(private readonly db: TursoRnDatabase) {}

  prepare(sql: string): Promise<TursoRnStatement> {
    return Promise.resolve(new TursoRnStatement(this.db.prepare(sql)));
  }

  all(sql: string, ...params: BindParams[]): Promise<Row[]> {
    return this.db.all(sql, ...params);
  }

  get(sql: string, ...params: BindParams[]): Promise<Row | undefined> {
    return this.db.get(sql, ...params);
  }

  run(sql: string, ...params: BindParams[]): Promise<RunResult> {
    return this.db.run(sql, ...params);
  }

  /**
   * Drizzle calls `client.transaction(fn)()` (a callable); the RN
   * `Database.transaction(fn)` returns a `Promise` directly, so return a thunk
   * that runs `fn` inside the RN transaction.
   */
  transaction<T>(fn: () => T | Promise<T>): () => Promise<T> {
    return () => this.db.transaction(fn);
  }
}

/**
 * Wrap an on-device Turso `Database` as a Drizzle {@link DomainDb} using the
 * RN-safe Turso session internals (no native imports). Apply migrations
 * afterwards via `applyMigrations` from `@rfid/domain`.
 */
export function drizzleTursoRn(db: TursoRnDatabase): DomainDb {
  const dialect = new SQLiteDialect();
  // Single, documented cast: `DatabasePromise` has private members, so the
  // adapter is not structurally assignable. See module doc.
  const session = new TursoDatabaseSession(
    new TursoRnClient(db) as unknown as TursoClient,
    dialect,
    {},
    {},
  );
  return new TursoDatabaseDatabase("async", dialect, session, {});
}
