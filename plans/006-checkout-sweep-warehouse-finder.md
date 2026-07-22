# Plan 006: Check Out, Sweep & Count, Warehouse browse, Find a Tag, Admin

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79443fb..HEAD -- apps/warehouse/db.py apps/warehouse/app.py apps/warehouse/config.py apps/field packages/domain`
> If `apps/warehouse/db.py` or `app.py` changed since `79443fb`, compare the
> excerpts below against the live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/004-field-app-foundation-and-checkin.md
- **Category**: migration
- **Planned at**: commit `79443fb`, 2026-07-22

## Why this matters

These are the remaining operator modes. Check Out draws units out of boxes as
they leave for site; Sweep & Count audits what's physically present; the
Warehouse view is how anyone answers "what do we have and where"; Find a Tag
locates one specific box by RSSI. Together with plan 004's check-in they make
the phone a complete replacement for the PC app's daily use.

## Current state

All domain functions exist in `packages/domain` (plan 002); this plan is
UI + wiring. The behavioral spec, from Python:

**Check Out is two-step** (`apps/warehouse/app.py:196-203`, db.py:744-857):
a trigger pull only **looks the box up** (`lookupForCheckout`) and shows a
confirm card (type, name, BOL, building, `remaining` of `quantity`); the
operator picks how many units (default: whole box) and a destination
building, then commits via `deliverUnits`. Unregistered / already-empty boxes
show their error and commit nothing. If the destination differs from the
received building the result carries the mismatch flag — surface it loudly.

**Sweep & Count** (`apps/warehouse/app.py:205-211`, db.py:859-923): each
trigger-hold produces an `inventory` event with the burst's distinct EPCs;
`recordInventory` reports `counts` per item type (units remaining), `unknown`
EPCs, and `flagged` ghosts ("Checked out …; detected in sweep"). The screen
accumulates EPCs **across trigger pulls within a session** (the browser did
this; app.py:208-210 notes the raw EPCs ride along for exactly this reason)
and offers "Compare against expected" → `compareInventory` → found /
missing counts + the missing-tag list. Read-only for quantities.

**Warehouse browse** (`apps/warehouse/app.py:284-297,386-400,425-462`,
db.py:957-1094): tree of item type → groups, toggled by BOL # / Building #
(W.I.F. groups by component name regardless); each group row shows qty (units
in warehouse), total capacity, boxes, vendors, the other dimension's values,
received date, status chip (In Warehouse / Partial / Delivered), note count,
and a flagged-box count. Filters: BOL substring, building, received from/to,
checked-out from/to. Drill-down lists individual boxes; each box row has
**Find** (→ finder targeting its EPC) and **Check Out** (→ the same confirm
card, no trigger needed, via `lookupForCheckout`). Export: build a CSV with
the exact column list of `EXPORT_COLUMNS` (app.py:404-422) and hand it to the
iOS share sheet (`expo-sharing` + `expo-file-system`).

**Find a Tag** (`apps/warehouse/app.py:939-943`, reader.py finder mode,
config.py:61-74): entered from a box row with a `targetEpc`;
`readerService.setMode("finder", {targetEpc})`. While the trigger is held the
app receives `{event:"finder", epc, rssi, percent}` (percent already mapped
0–100 by `@rfid/reader-protocol`); show a big proximity bar + percent, pulse
haptics faster as percent rises (`expo-haptics`), and on first crossing ≥90%
fire `readerService.alert()` (the handheld vibrates — one-shot per aim).
`finder_reset` (trigger released) resets the UI for the next aim. Leaving the
screen sets mode idle.

**Event Log** (`apps/warehouse/app.py:300-310`, db.py:1117-1151): newest
first, filter all/checkin/checkout/scan + EPC substring search.

**Admin** (`apps/warehouse/app.py:797-916`, config.py:159): PIN-gated
(default "1234", stored on-device; a settings field to change it), actions:
edit tag (EDITABLE fields, consistency rules live in domain `updateTag`),
clear flag, delete group, remove vendor, clear database. Keep the PIN check
local (`_check_pin` equivalent) — it's "light protection for a trusted
machine, not real security" (config.py:157-159).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm -r typecheck` | exit 0 |
| Domain tests | `pnpm --filter @rfid/domain test` | all pass |
| Bundle check | `pnpm --filter @rfid/field exec expo export --platform ios` | exit 0 |

## Scope

**In scope**:
- `apps/field/**`: `app/check-out.tsx`, `app/sweep.tsx`, `app/warehouse.tsx`
  (+ drill-down route), `app/finder.tsx`, `app/events.tsx`, `app/admin.tsx`,
  shared components; home-screen cards wired up.
- `packages/domain`: only if a read helper is missing (e.g. a
  `csvExport(rows)` formatter); no schema changes.
- root `pnpm-lock.yaml` (expo-haptics, expo-sharing, expo-file-system).

**Out of scope**:
- Requests/staging (plan 008 — but build the checkout confirm card as a
  reusable component; 008 reuses it).
- BOL document viewing (plan 007 adds the document link on group rows).
- `apps/warehouse/**` — reference only.

## Git workflow

- Branch: `advisor/006-modes-and-warehouse`
- Commit per screen, short imperative messages (repo style).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Check Out screen + reusable confirm card

`CheckoutConfirmCard` component: props `{lookupResult, onCommit(amount, building), staged?: boolean}`
— shows box details, amount stepper clamped to `[1, remaining]` defaulting to
`remaining`, destination-building segmented control (`BUILDING_OPTIONS` +
free entry), commit button. `app/check-out.tsx`: sets mode `checkout` on
focus / `idle` on blur; on `{event:"scan", mode:"checkout"}` runs
`lookupForCheckout` and shows the card; commit calls `deliverUnits`, appends
a result row (message + mismatch flag banner when present), ready for the
next pull.

**Verify**: `pnpm -r typecheck` → exit 0; simulator (if available): inject a
checked-in EPC → card appears; commit 1 of 2 units → "Partial" reported;
inject an unknown EPC → "not registered" row, nothing committed.

### Step 2: Sweep & Count screen

Mode `inventory` on focus. Maintain a session set of EPCs; each
`inventory` event merges `event.epcs` and calls `recordInventory` with just
the new burst (matching app.py:205-211 — the DB logs per burst; the session
set is UI state). Display: per-type unit counts, distinct-tag total, unknown
list, flagged list (red), and a "Reconcile" button →
`compareInventory(sessionEpcs)` → expected/found/missing summary + missing
boxes list. "New session" clears the set.

**Verify**: typecheck; simulator: two injected bursts accumulate; a delivered
tag injected in a sweep shows in flagged.

### Step 3: Warehouse browse + drill-down + CSV share

`app/warehouse.tsx`: group-by toggle (BOL/Building), filter sheet (the five
filters), tree from `inventoryTree` — type header rows with qty, expandable
group rows showing the columns listed in "Current state". Drill-down route
lists `groupTags` boxes: EPC (last 6 chars emphasized), Item No., mfc date,
remaining/quantity, status, flag; buttons **Find** (→ `/finder?epc=…`) and
**Check Out** (opens `CheckoutConfirmCard` with a direct
`lookupForCheckout`). Export button: format `exportRows` through the
`EXPORT_COLUMNS` header list (port from app.py:404-422 into
`packages/domain/src/repo/exportCsv.ts` with a unit test), write to a cache
file, open the share sheet.

**Verify**: typecheck; domain test for `exportCsv` (header row exactly
`EPC,Item Type,Item Name,BOL #,PO #,Building #,Sector,Checked Out To,Vendor,Item No.,Mfc Date,Units Remaining,Units Total,Status,Received,Checked Out,Flag`).

### Step 4: Finder screen

`app/finder.tsx?epc=…`: shows the target box (via `findTag`), sets mode
`finder` with the target EPC. Big vertical bar + percent from `finder`
events; haptic pulse interval `lerp(600ms → 80ms)` over percent 0→100; fire
`readerService.alert()` once per aim at ≥90%; `finder_reset` clears the bar
and re-arms the alert. Blur → mode idle.

**Verify**: typecheck; simulator: simulated transport streams RI values for
the target → bar moves, resets on simulated `SW:off`.

### Step 5: Event Log + Admin

- `app/events.tsx`: `listEvents` with the four filter chips + EPC search box.
- `app/admin.tsx`: PIN prompt (stored PIN in AsyncStorage, default "1234");
  then: tag editor (lookup by EPC → form over domain `EDITABLE` fields →
  `updateTag`; show returned tag), clear flag, delete group (type + group
  picker → `deleteGroup`, destructive confirm), vendor remove, "Clear
  database" (double confirm, calls `clearAll`).
- Home screen: wire all mode cards; remove placeholders.

**Verify**: `pnpm -r typecheck` → exit 0; `expo export` → exit 0.

## Test plan

- New domain test: `exportCsv` header + a row round-trip.
- Everything else is UI over already-tested domain functions; verify by
  typecheck, bundle, and the per-step simulator scripts when a simulator is
  available. Do not add a UI test framework in this plan.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm -r typecheck` exits 0
- [ ] `pnpm --filter @rfid/domain test` exits 0 incl. exportCsv test
- [ ] `pnpm --filter @rfid/field exec expo export --platform ios` exits 0
- [ ] `grep -rn "deliverUnits\|lookupForCheckout" apps/field/src | wc -l` ≥ 2 (checkout wired through domain)
- [ ] Home screen has no "coming soon" placeholder for Check Out / Sweep / Warehouse / Event Log / Admin (grep for `coming soon` under `apps/field/src` + `apps/field/app` → no matches except a Requests placeholder, which plan 008 removes)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any domain function needed here is missing from `packages/domain` (means
  plan 002 drifted) — report the gap; do not write SQL in the app.
- The finder percent/haptics loop can't keep up with event volume in the
  simulator (report frequency observed; do not throttle inside
  `@rfid/reader-protocol`).
- You need a schema change. None is expected here.

## Maintenance notes

- `CheckoutConfirmCard` is deliberately reusable: plan 008's request staging
  renders it in `staged` mode. Keep commit side-effects out of the card
  (callers commit).
- Sweep sessions are UI state only; if persistence across app restarts is
  ever wanted, that's a new feature, not a bug fix.
- Deferred: PDF export (the PC app printed via the browser; share-sheet CSV
  covers the need), and pagination on the event log beyond the 500-row cap.
