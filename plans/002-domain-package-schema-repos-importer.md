# Plan 002: Domain package — schema, constants, repositories, importer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79443fb..HEAD -- packages/domain apps/warehouse/db.py apps/warehouse/config.py apps/warehouse/intake.py`
> If `apps/warehouse/db.py`, `config.py`, or `intake.py` changed since this
> plan was written, compare the excerpts below against the live code before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (this package IS the business logic; every later plan calls it)
- **Depends on**: plans/001-scaffold-typescript-monorepo.md
- **Category**: migration
- **Planned at**: commit `79443fb`, 2026-07-22

## Why this matters

The entire warehouse domain — how a box becomes inventory, how units are
drawn down, how sweeps flag ghosts, how requests are fulfilled — lives today
in `apps/warehouse/db.py` (1,624 lines of Python against SQLite). The Expo
field app and the Next.js web app both need exactly this logic in
TypeScript. This plan ports it into `packages/domain` as pure, Node-testable
code over a minimal SQL interface, plus a one-shot importer that copies a
production `inventory.db` into a new-schema database. If this package is
correct, plans 004–009 are mostly UI.

## Current state

Reference files (the Python is the behavioral spec — port it, don't redesign):

- `apps/warehouse/db.py` — every table and repository function. Schema DDL at
  lines 105–200; migrations at 217–295 (already folded into the DDL below).
- `apps/warehouse/config.py` — item types and field definitions (lines
  218–256), EPC prefix (line 147).
- `apps/warehouse/intake.py` — the armed-shipment workflow and recording rules.
- `CONTEXT.md` — vocabulary. Use these names in code: **intake**, **armed
  shipment**, "Item No." is the user-facing name for the `sku` column.

Key behavioral rules, quoted so you don't have to infer them:

Status constants (`apps/warehouse/db.py:39-51`):

```39:51:apps/warehouse/db.py
STATUS_IN = "In Warehouse"
STATUS_DELIVERED = "Delivered"
STATUS_PARTIAL = "Partial"

# Material-request lifecycle (rows are created by the cloud app; the manager
# resolves them here). staging = the manager is scanning boxes for it in the
# checkout screen; fulfilled is only reachable through fulfill_request().
REQUEST_PENDING = "pending"
REQUEST_STAGING = "staging"
REQUEST_FULFILLED = "fulfilled"
REQUEST_DECLINED = "declined"
```

Quantities are always derived (`apps/warehouse/db.py:5-7`): "A 'shipment' /
warehouse-inventory row is a derived aggregation over tags grouped by
(item_type, bol_number, building), so quantities are always a COUNT and can
never drift out of sync." Group quantity = `SUM(remaining)`
(`_group_in_warehouse_qty`, db.py:306-313).

Check-out drawdown (`deliver_units` / `_deliver_units_locked`,
db.py:771-857): amount is clamped to `[1, remaining]`, `None` means the whole
box; `remaining == 0` → status `Delivered`, else `Partial`; `delivered_at` is
set on **every** draw; if the operator's destination building differs from the
building the box was received for, the tag gets
`flag = "Checked out to Bldg X but received for Bldg Y"` plus a `FLAG` event.

Sweep (`record_inventory`, db.py:859-901): read-only for quantities; logs a
`COUNT` event per tag; a tag with `remaining <= 0` detected in a sweep is
persistently flagged `"Checked out <date>; detected in sweep"`.

Fulfillment (`fulfill_request`, db.py:1523-1600): applies each staged draw
via the normal checkout path **inside one transaction**; if nothing was
delivered → rollback + error; if delivered < requested and no note → rollback
+ `note_required: true`; on success sets status `fulfilled` + handler_note
(prefixed `"N of M supplied"` when short).

Request transitions (db.py:1482-1485): `pending → staging|declined`,
`staging → pending|declined`; `fulfilled` is reachable only via
`fulfill_request`.

Admin tag edit (`update_tag`, db.py:1218-1295): editing `status` or
`remaining` keeps the other consistent (status `In Warehouse` resets
remaining=quantity and clears delivered_at/flag; remaining=0 derives
`Delivered` and stamps delivered_at if empty; etc.). Port these rules exactly.

EPC minting (`allocate_epcs`, db.py:342-369): 24-hex EPCs, prefix `42473031`
(config.py:147), serial persisted in a key/value table, collision-checked
against `tags`. **This plan changes the layout to be multi-device safe** (see
`plans/README.md` "Standing decisions"): EPC = 8-hex prefix + 2-hex device id
+ 14-hex per-device serial.

Item types and fields (`apps/warehouse/config.py:218-256`): item types
`["TSC", "CDU", "W.I.F."]`; `NAMED_ITEM_TYPES = ["W.I.F."]` (their boxes
carry a per-unit `item_name`, group by it in the warehouse view);
shipment-scope fields `building_number` (buttons: "6","7","8"), `sector`,
`bol_number`, `po_number`, `vendor` (select); item-scope fields `sku`
("Item No."), `mfc_date` (date), `quantity` (number).

Timestamps: local ISO seconds (`datetime.now().isoformat(timespec="seconds")`,
db.py:66-67); `delivered_at` display date format `MM/DD/YYYY`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install new deps | `pnpm install` (root) | exit 0 |
| Typecheck | `pnpm --filter @rfid/domain typecheck` | exit 0 |
| Tests | `pnpm --filter @rfid/domain test` | all pass |
| Importer smoke | `pnpm --filter @rfid/domain exec tsx src/importer/cli.ts --from <legacy.db> --to <new.db>` | prints row counts, exit 0 |

## Scope

**In scope** (the only paths you may modify/create):
- `packages/domain/**` (replace the plan-001 stub)
- root `pnpm-lock.yaml` (via `pnpm install`)

**Out of scope**:
- `apps/warehouse/**`, `apps/cloud/**`, `packages/contract/**` — read-only
  references.
- `apps/field/**`, `apps/web/**` — later plans wire them up.
- No Turso **cloud** access: everything here runs against local database files.

## Git workflow

- Branch: `advisor/002-domain-package`
- Commit per step, short imperative messages (repo style, e.g. "Add domain
  schema and SqlDatabase interface").
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: SqlDatabase interface + Node test harness

Add dependencies to `packages/domain`: dev `@tursodatabase/database` (Node
Turso engine, SQLite-compatible — used in tests and by the importer), `tsx`,
and `better-sqlite3` + `@types/better-sqlite3` (importer reads the legacy file
with a boring, battle-tested reader).

Create `src/sql.ts`:

```ts
export interface SqlDatabase {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}
```

This matches both `@tursodatabase/database` (Node) and
`@tursodatabase/sync-react-native` (device), so repositories written against
it run everywhere. Add `src/testing/openTestDb.ts` that opens an in-memory /
temp-file Node Turso database, applies the schema (step 2), and returns a
`SqlDatabase`.

Transactions: add `withTransaction(db, fn)` helper in `src/sql.ts` that runs
`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` via `exec`. All multi-write
repository functions use it.

**Verify**: `pnpm --filter @rfid/domain typecheck` → exit 0.

### Step 2: Schema

Create `src/schema.ts` exporting `SCHEMA_SQL` (a single executable script) and
`applySchema(db)`. Tables, ported 1:1 from `apps/warehouse/db.py:105-200`
with the post-migration columns folded in:

- `tags` — exactly the columns of db.py:105-127 **plus** `bol_doc_id INTEGER`
  (migration, db.py:253-254). Keep names, defaults, and `epc TEXT UNIQUE NOT
  NULL`.
- `events` — db.py:128-138 (`id, ts, action, epc, item_type, bol_number,
  building, vendor, detail`).
- `vendors` — `name TEXT PRIMARY KEY`.
- `bol_docs` — db.py:142-157 **plus** `storage_url TEXT NOT NULL DEFAULT ''`
  (new: blob-storage location once uploaded; plan 007/010 use it).
- `notes` — db.py:158-165.
- `requests` — db.py:170-187, with one change: drop `status_dirty` (that
  column existed to re-push statuses through the custom sync; Turso syncs the
  row itself). Keep `order_ref`, `item_name`, and add
  `updated_at TEXT NOT NULL DEFAULT ''`.
- `local_meta` — key/value (`key TEXT PRIMARY KEY, value TEXT NOT NULL`),
  replacing `sync_state` for the EPC serial and device id only.
- Indexes from db.py:193-199 (`idx_tags_group`, `idx_tags_status`,
  `idx_events_action`, `idx_events_epc`, `idx_notes_group`).

Use `INTEGER PRIMARY KEY AUTOINCREMENT` for `tags.id`, `events.id`,
`bol_docs.id`, `notes.id`; `requests.id` is `INTEGER PRIMARY KEY` **without**
autoincrement in the legacy schema — in the new world the web app inserts
requests, so make it `INTEGER PRIMARY KEY AUTOINCREMENT` too.

**Verify**: a vitest test creates a DB via `openTestDb`, then
`SELECT name FROM sqlite_master WHERE type='table'` returns exactly
`tags, events, vendors, bol_docs, notes, requests, local_meta` (plus
`sqlite_sequence`).

### Step 3: Constants and types

Create `src/constants.ts` porting `apps/warehouse/config.py:218-256`:
`ITEM_TYPES`, `NAMED_ITEM_TYPES`, `BUILDING_OPTIONS`, `SHIPMENT_FIELDS`,
`ITEM_FIELDS`, `ITEM_NAME_FIELD`, `TYPE_FIELDS`, and the status/request
constants from db.py:39-51. Field defs keep the same shape
(`{ key, label, type, scope, options?, suggest? }`).

Create `src/types.ts` with `Tag`, `EventRow`, `BolDoc`, `MaterialRequest`,
`Note` interfaces matching the table columns (strings/numbers as stored).

**Verify**: `pnpm --filter @rfid/domain typecheck` → exit 0.

### Step 4: Repositories

Create one module per area under `src/repo/`. Every function takes
`db: SqlDatabase` as its first argument, returns plain objects, and logs the
same event actions as Python (`IN`, `OUT`, `COUNT`, `FLAG`, `EDIT`, `NOTE`,
`NOTE_DEL`, `BOL_SCAN`, `BOL_RENAME`, `BOL_DELETE`, `VENDOR_ADD`,
`VENDOR_DEL`, `DELETE`, `CLEAR`, `UNFLAG`, `REQUEST`, `REQUEST_STAGING`,
`REQUEST_PENDING`, `REQUEST_DECLINED`, `REQUEST_FULFILLED`). Port these
functions (Python name → file:line in `apps/warehouse/db.py`):

1. `src/repo/intake.ts` — `receiveShipment` (371–434: dedupe EPCs uppercase,
   skip existing as `duplicates`, insert with quantity=remaining=units, log
   `IN` with the same detail format, return the same result shape including
   group qty), `amendCheckin` (436–486: only `item_name/sku/mfc_date/quantity`;
   a quantity edit resets `remaining`; log `EDIT` with
   `"check-in fix: field: 'old' -> 'new'"`), `allocateEpcs` (342–369, with the
   new layout: `EPC = "42473031" + deviceId(2 hex) + serial(14 hex)`;
   `deviceId` and `epc_serial` live in `local_meta`; still collision-check
   against `tags`).
2. `src/repo/checkout.ts` — `lookupForCheckout` (744–769), `deliverUnits`
   (771–857) with an internal `deliverUnitsInTx` reused by fulfillment.
3. `src/repo/inventory.ts` — `recordInventory` (859–901), `compareInventory`
   (903–923), `inventoryTree` (957–1064: including named-type grouping by
   `item_name`, `other_values`, `vendors`, `flagged`, note counts, and the
   qty/status derivation), `groupTags` (1066–1083), `exportRows` (1085–1094),
   `findTag` (1096–1102), `itemNameSuggestions` (1104–1112), and the filter
   builder `_filter_where` (926–955).
4. `src/repo/events.ts` — `logEvent` (298–304), `listEvents` (1117–1151 with
   the same filter categories and 500-row default cap).
5. `src/repo/vendors.ts` — `listVendors`, `addVendor`, `removeVendor`
   (1318–1344).
6. `src/repo/notes.ts` — `addNote`, `listNotes`, `deleteNote` (685–742;
   note the None-vs-'' filter semantics of `list_notes`: an omitted filter
   skips the clause, empty string matches blank).
7. `src/repo/bolDocs.ts` — `createBolDoc`, `getBolDoc`, `listBolDocs`,
   `deleteBolDoc`, `renameBolDoc`, `setBolDocPages`, `applyBolExtraction`
   (505–673). File deletion on disk is the caller's job in the new world:
   return the filename instead of unlinking (no `os.remove` equivalent here).
8. `src/repo/requests.ts` — `createRequest` (new: direct insert, used by the
   web app; sets status `pending`, `created_at` now, logs nothing — events are
   the warehouse device's audit trail), `listRequests` + open-first ordering
   (1459–1470), `countOpenRequests` (1472–1478), `setRequestStatus` with the
   transition table (1487–1521), `fulfillRequest` (1523–1600) using
   `withTransaction` + `deliverUnitsInTx`.
9. `src/repo/admin.ts` — `updateTag` (1218–1295 with all consistency rules),
   `clearFlag` (1297–1315), `deleteGroup` (1178–1211), `clearAll` (1154–1176,
   returning the list of BOL filenames for the caller to delete).

Export everything from `src/index.ts`.

**Verify**: `pnpm --filter @rfid/domain typecheck` → exit 0.

### Step 5: Tests

Create vitest suites under `src/repo/__tests__/`, one file per repo module,
using `openTestDb`. Minimum cases (all asserting against the rules quoted in
"Current state"):

- intake: receive 3 EPCs → group qty = sum of units; duplicate EPC reported
  in `duplicates` and not re-inserted; amend quantity resets remaining;
  `allocateEpcs(3)` mints 24-hex, unique, prefix `42473031`, device id
  embedded; collision with an existing tag EPC is skipped.
- checkout: full draw → `Delivered`, partial → `Partial`; amount clamped;
  destination ≠ received building sets the flag text exactly
  `"Checked out to Bldg 7 but received for Bldg 6"` and logs `FLAG`;
  already-empty box returns `ok: false`.
- inventory: sweep of a delivered tag flags it and excludes it from counts;
  unknown EPC → `unknown` + `COUNT` event with item_type UNKNOWN;
  `compareInventory` partitions found/missing; `inventoryTree` groups W.I.F.
  by item_name and others by BOL, statuses derive from qty vs capacity.
- requests: transition table enforced (fulfilled unreachable via
  `setRequestStatus`); `fulfillRequest` short-without-note rolls back
  (tag remaining unchanged — assert it) and returns `note_required`;
  successful fulfill decrements tags and sets handler_note `"1 of 2 supplied — <note>"` when short.
- admin: `updateTag` status→`In Warehouse` resets remaining/delivered_at/flag;
  remaining→0 derives `Delivered`.
- events: `listEvents("checkout")` returns only `OUT` actions.

**Verify**: `pnpm --filter @rfid/domain test` → all pass (expect ~25+ tests).

### Step 6: Importer

Create `src/importer/importLegacy.ts` + `src/importer/cli.ts`:

- Opens the legacy SQLite file read-only with `better-sqlite3`.
- Opens/creates the target with `@tursodatabase/database`, applies
  `SCHEMA_SQL`.
- Copies `tags` (all columns incl. `bol_doc_id`), `events`, `vendors`,
  `notes`, `bol_docs` (legacy rows get `storage_url ''`), `requests`
  (dropping `status_dirty`), preserving ids.
- Seeds `local_meta`: `epc_serial` from legacy `sync_state.epc_serial` if
  present (else the max serial parsed from existing `42473031…` EPCs, else 0)
  — imported under device id `00` semantics; new devices get ids ≥ `01` so
  legacy serials can't collide.
- Prints a per-table `legacy=N imported=N` line and exits nonzero on any
  mismatch.

Create a test that builds a small legacy-format DB in a temp file (write the
legacy DDL from `apps/warehouse/db.py:105-200` directly in the test), runs the
importer, and asserts row counts and a spot-checked tag round-trips.

**Verify**: `pnpm --filter @rfid/domain test` → importer test passes. If a
real `apps/warehouse/inventory.db` exists locally, also run the CLI against a
**copy** of it (never the original) and confirm matching counts.

## Test plan

Covered in steps 5–6. Model test structure after the stub
`packages/domain/src/index.test.ts` from plan 001 (plain vitest, no mocks —
real SQL against a temp database is the point).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @rfid/domain typecheck` exits 0
- [ ] `pnpm --filter @rfid/domain test` exits 0 with suites for intake,
      checkout, inventory, requests, admin, events, importer
- [ ] `grep -rn "react-native" packages/domain/src` returns no matches
      (package stays Node-pure)
- [ ] `git diff --name-only` touches only `packages/domain/**` and
      `pnpm-lock.yaml`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `@tursodatabase/database` cannot execute the ported schema (SQL dialect
  gap) — report the exact statement; do not silently rewrite table shapes.
- Any behavioral rule in "Current state" contradicts what you find in
  `apps/warehouse/db.py` when you open it (drift since `79443fb`).
- The importer cannot preserve `tags.id` / `events.id` (identity matters for
  audit continuity).
- You are tempted to "improve" a rule (e.g. change flag text, statuses, event
  actions). Don't — the web UI, printed labels, and operator muscle memory
  depend on exact strings.

## Maintenance notes

- This package is the single source of domain truth; plans 004–009 must call
  it rather than writing SQL in the apps. A reviewer should reject any later
  diff embedding SQL in `apps/field` or `apps/web`.
- `local_meta.device_id` assignment happens in plan 010 (first-run setup);
  until then tests pass `deviceId` explicitly.
- Deferred: full-text search over `bol_docs.ocr_text`, and any schema change
  beyond `storage_url`/`updated_at` — do not add columns speculatively.
