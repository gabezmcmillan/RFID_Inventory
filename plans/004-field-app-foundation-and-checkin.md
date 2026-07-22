# Plan 004: Field app foundation + Check In (scan path)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79443fb..HEAD -- apps/field packages/domain packages/reader-protocol apps/warehouse/intake.py apps/warehouse/app.py apps/warehouse/config.py`
> Plans 001–003 are expected to have landed (their paths will show changes).
> If `apps/warehouse/intake.py` or `config.py` changed since `79443fb`,
> compare the excerpts below against the live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/002-domain-package-schema-repos-importer.md, plans/003-reader-protocol-and-bluetooth-transport.md
- **Category**: migration
- **Planned at**: commit `79443fb`, 2026-07-22

## Why this matters

Check In is the workhorse mode: a truckload arrives, the operator arms a
shipment (item type + shipment fields), then pulls the trigger once per box
while adjusting per-unit fields between pulls. This plan stands up the field
app's skeleton (navigation, local database, reader service wiring, settings)
and delivers the full scan-path check-in — the first end-to-end slice of the
rewrite, exercisable entirely with the simulated reader.

## Current state

- `packages/domain` (plan 002) has `receiveShipment`, `amendCheckin`,
  vendors/notes repos, constants (`ITEM_TYPES`, `TYPE_FIELDS`,
  `BUILDING_OPTIONS`, `NAMED_ITEM_TYPES`), and `applySchema`.
- `apps/field/src/reader/readerService.ts` (plan 003) emits
  `scan | inventory | live | finder | finder_reset | status` events and has
  `setMode`, `injectScan`, and the simulated transport.
- `apps/field` is still the blank Expo template rendering `DOMAIN_PACKAGE`.

Behavior to reproduce, from the Python app:

**Armed shipment** (`apps/warehouse/intake.py:47-84` and `CONTEXT.md:13-17`):
the armed shipment is `{item_type, fields}` set when the operator opens
check-in; per-unit fields (`sku`, `mfc_date`, `quantity`, and `item_name` for
W.I.F.) are held separately, updated before each trigger pull, and **reset on
re-arm**. A scan with nothing armed returns
`"No shipment armed for check-in."` (intake.py:80-82). The reader only
reports the EPC; meaning lives in intake.

**Event flow** (`apps/warehouse/app.py:188-194`): a `scan` event in checkin
mode → `check_in_scanned(epc)` → broadcast the result. Intake **stays armed**
after each scan so more units can be tagged.

**Mode arming** (`apps/warehouse/app.py:919-948`): entering check-in requires
a valid `item_type`; entering any other mode disarms intake.

**Result shape** (`apps/warehouse/db.py:426-434`): message
`"Received 1 box (N units) of TYPE (BOL x, bldg)."`, `duplicates` lists EPCs
already on file (message appends `"N already on file."`).

**Amend** (`apps/warehouse/intake.py:143-151`): operator can fix
`item_name/sku/mfc_date/quantity` of the just-scanned tag, no PIN.

**Fields** (`apps/warehouse/config.py:218-256`): shipment scope =
Building # (buttons 6/7/8), Sector (text), BOL Number, PO Number, Vendor
(select, managed list, addable from check-in per app.py:327-335); item scope
= Item No. (`sku`), Manufactured Date, Quantity; W.I.F. adds Item Name with
autocomplete from `itemNameSuggestions`.

BOL-document scanning/prefill is **plan 007**; this plan's check-in form has
a manual "BOL Number" text field only. Label printing is **plan 005**.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` (root) | exit 0 |
| Typecheck | `pnpm -r typecheck` | exit 0 |
| Domain tests still green | `pnpm --filter @rfid/domain test` | all pass |
| Bundle check | `pnpm --filter @rfid/field exec expo export --platform ios` | exit 0 |
| Simulator run (if Xcode present) | `pnpm --filter @rfid/field exec expo run:ios` | app boots |

## Scope

**In scope**:
- `apps/field/**` (navigation, screens, db provider, stores, settings)
- `packages/domain/src/intakeSession.ts` (new: the armed-shipment state
  machine, pure TS — port of `intake.py` minus printing)
- root `pnpm-lock.yaml`

**Out of scope**:
- Printing (plan 005), checkout/sweep/finder/warehouse screens (006), BOL
  capture (007), requests (008), Turso cloud sync (010).
- `apps/warehouse/**`, `apps/cloud/**` — reference only.

## Git workflow

- Branch: `advisor/004-field-checkin`
- Commit per step, short imperative messages (repo style).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Navigation + local database + app shell

- Add `expo-router` per Expo docs (entry point `"main": "expo-router/entry"`,
  `app/` directory). Screens this plan creates: `app/index.tsx` (mode home),
  `app/check-in.tsx`, `app/settings.tsx`, `app/dev-tools.tsx`.
- Add `@tursodatabase/sync-react-native`. Create
  `apps/field/src/db/provider.tsx`: opens a **local-only** database
  (`new Database({ path: getDbPath("inventory.db") })`, no `url` — plan 010
  adds sync), adapts it to `@rfid/domain`'s `SqlDatabase` interface, runs
  `applySchema` on first open, seeds `local_meta.device_id = "01"` if absent,
  and exposes `useDb()` via React context. All screens render a loading state
  until the DB is open.
- Mode home: cards for Check In, Check Out, Sweep & Count, Warehouse,
  Requests (the latter three navigate to "coming in plan 006/008"
  placeholders), a reader status pill fed by `readerService` status events,
  and a gear icon → settings.
- Settings screen: transport toggle (Simulated / Bluetooth sled — persisted
  with `@react-native-async-storage/async-storage`), check-power slider
  10–29 dBm calling `readerService.setCheckPower` (mirrors
  `apps/warehouse/app.py:262-268`).
- Dev tools screen (dev builds only): text box + button calling
  `readerService.injectScan([...epcs])`, and a "simulate trigger pull with
  RSSI" control using the simulated transport — the no-hardware rig, the
  equivalent of `POST /api/simulate_scan` (app.py:1065-1071).

**Verify**: `pnpm -r typecheck` → exit 0;
`pnpm --filter @rfid/field exec expo export --platform ios` → exit 0.

### Step 2: Intake session in the domain package

Create `packages/domain/src/intakeSession.ts` — a class port of
`ShipmentIntake` (`apps/warehouse/intake.py`) minus the printer path (plan
005 adds it):

- `arm(itemType, fields)` — stores `{itemType, fields}`, clears item fields.
- `disarm()`, `setItemFields(fields)`, `getArmed()`.
- `async checkInScanned(db, epc)` — returns
  `{ok:false, message:"No shipment armed for check-in."}` when disarmed;
  otherwise calls `receiveShipment` with the armed shipment + current item
  fields (field mapping exactly as `intake.py:154-163`: `building_number`,
  `bol_number`, `vendor`, `po_number`, `sector`, `bol_doc_id` coerced to a
  positive int or null).
- `amend(db, epc, fields)` — filters to
  `("item_name","sku","mfc_date","quantity")` (intake.py:42) then calls
  `amendCheckin`.

Vitest suite: disarmed scan message; arm→scan→group qty; re-arm resets item
fields; amend filters unknown keys.

**Verify**: `pnpm --filter @rfid/domain test` → all pass including new suite.

### Step 3: Check In screen

`app/check-in.tsx` + components under `apps/field/src/screens/checkin/`:

1. **Setup phase**: item-type selector (from `ITEM_TYPES`); shipment fields
   rendered from `TYPE_FIELDS[itemType]` filtering `scope === "shipment"` —
   `buttons` type renders `BUILDING_OPTIONS` as segmented buttons, `select`
   renders the vendor picker (options from `listVendors`, "+ Add vendor"
   inline calling `addVendor`), others render text inputs. "Start check-in"
   arms the intake session AND calls `readerService.setMode("checkin")`.
2. **Scanning phase**: per-unit fields (from `scope === "item"`, plus Item
   Name with autocomplete via `itemNameSuggestions` when
   `NAMED_ITEM_TYPES.includes(itemType)`); every edit calls
   `intakeSession.setItemFields`. Subscribe to reader events: on
   `{event:"scan", mode:"checkin"}` call `checkInScanned`, append a result
   card to a session list (message, EPC, group qty; duplicates styled as a
   warning), and keep scanning. An "Edit" button on the newest card opens the
   amend sheet (item name / Item No. / mfc date / qty → `amend`).
3. Notes: an "Add note" affordance posting via the notes repo with the armed
   triple (item_type, bol_number, building) — mirrors app.py:362-371.
4. Leaving the screen (or "End check-in") disarms and sets mode `idle` —
   mirrors app.py:944-947 (any non-checkin mode disarms).

Wire the session's reader-event subscription through one hook
(`useReaderEvents(handler)`) so plans 006/008 reuse it.

**Verify**: `pnpm -r typecheck` → exit 0; `expo export` → exit 0. If a
simulator is available: run the app, arm a TSC shipment (bldg 6, BOL "TEST1"),
dev-tools inject `AAAA11112222333344445555` → result card shows
"Received 1 box (1 units) of TSC (BOL TEST1, 6)."; inject the same EPC again
→ duplicate warning.

## Test plan

- Domain: the intake-session suite from step 2 (4+ cases).
- Field app UI is verified by typecheck + bundling + (when simulator
  available) the manual script in step 3's Verify. Do not introduce a UI
  test framework in this plan.
- Verification: `pnpm --filter @rfid/domain test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm -r typecheck` exits 0
- [ ] `pnpm --filter @rfid/domain test` exits 0 incl. intakeSession suite
- [ ] `pnpm --filter @rfid/field exec expo export --platform ios` exits 0
- [ ] `grep -rn "No shipment armed for check-in." packages/domain/src` → 1 match
- [ ] `grep -rln "SELECT\|INSERT INTO" apps/field/src --include "*.tsx" --include "*.ts" | grep -v db/provider` → no matches (all SQL stays in @rfid/domain)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `@tursodatabase/sync-react-native` fails to install or its API does not
  match the `SqlDatabase` adapter shape (report the actual API surface).
- expo-router installation conflicts with the plan-001 template in a way not
  fixed by following Expo's official "install expo-router" doc.
- Reproducing the armed-shipment flow requires state living anywhere other
  than the intake session (e.g. in the reader) — that inversion is exactly
  what `intake.py` was created to fix; report instead of re-introducing it.

## Maintenance notes

- `intakeSession` is shared state between check-in UI and (plan 005) the
  print path; keep it a singleton in the field app.
- The `useReaderEvents` hook is the seam every mode screen uses; plan 006
  builds on it — don't let screens subscribe to the transport directly.
- Deferred to plan 007: BOL scan/prefill and the "resume recent BOL" list;
  to plan 005: the Print & encode button on this screen.
