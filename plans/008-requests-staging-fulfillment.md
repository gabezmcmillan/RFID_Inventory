# Plan 008: Requests — badge, staging, fulfillment, decline

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79443fb..HEAD -- apps/warehouse/db.py apps/warehouse/app.py apps/field packages/domain`
> If `apps/warehouse/db.py` request functions (lines 1403-1620) changed since
> `79443fb`, compare the excerpts below against the live code; on a mismatch,
> STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (fulfillment commits inventory and request state atomically)
- **Depends on**: plans/006-checkout-sweep-warehouse-finder.md
- **Category**: migration
- **Planned at**: commit `79443fb`, 2026-07-22

## Why this matters

Jobsite users submit material requests on the web app; the warehouse manager
fulfills them from the phone. Fulfillment is the one flow where inventory
movement and request state must change together: boxes are staged (nothing
committed), then "Confirm delivery" checks them out and marks the request
fulfilled in a single transaction. Getting the state machine wrong strands
requests or double-ships stock.

## Current state

- Domain (plan 002) has `listRequests`, `countOpenRequests`,
  `setRequestStatus` (with the transition table), `fulfillRequest`, and
  `createRequest`. Plan 006 built `CheckoutConfirmCard` with a `staged` mode
  and the check-out screen.
- Until plan 010 syncs real requests from the web app, rows are created
  locally via a dev tool (step 1).

Behavioral spec (`apps/warehouse/db.py:1459-1600`, `app.py:486-542`, README
"Requests"):

- **Ordering**: open first — `staging`, then `pending`, then the rest,
  newest-first within (db.py:1466-1467). Badge = count of
  pending + staging (db.py:1472-1478).
- **Transitions** (db.py:1482-1521): `pending → staging` (Fulfill tapped),
  `staging → pending` (cancel staging; nothing was committed),
  `pending|staging → declined` (with note). Any other transition returns
  `"Request #N is X; cannot mark it Y."`. `fulfilled` only via
  `fulfillRequest`.
- **Staging flow**: Fulfill opens the Check Out screen in **staging mode**
  for that request: scanned boxes accumulate as staged draws
  (`{epc, amount, building}` — building defaults to the request's
  destination), removable, **nothing committed**. "Confirm delivery" calls
  `fulfillRequest(id, draws, note)`; the domain enforces: nothing delivered →
  rollback + error; short of requested quantity without a note → rollback +
  `note_required` (UI prompts for the note and retries); success → boxes
  checked out (same logging/flagging as standalone checkout) and status
  `fulfilled` with `handler_note` prefixed `"N of M supplied"` when short
  (db.py:1546-1591).
- **Request card content** (from the requests table): item type
  (+ item_name for W.I.F. as `"TYPE | name"`), quantity, destination
  building, jobsite, requester, contact, note, created_at, order_ref (lines
  of one cart order share it — group them visually), status,
  handled_at/handler_note when resolved.
- Handling a request in the Python app triggered an immediate sync
  (app.py:521-523, 539-541) "to tell the requester ASAP" — the analog here
  is calling the sync-now hook if one exists (plan 010 provides it; until
  then a no-op callback).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm -r typecheck` | exit 0 |
| Domain tests | `pnpm --filter @rfid/domain test` | all pass |
| Bundle check | `pnpm --filter @rfid/field exec expo export --platform ios` | exit 0 |

## Scope

**In scope**:
- `apps/field/**`: `app/requests.tsx` (+ detail), staging mode in the
  check-out screen, home-screen badge, dev tool "insert fake request".
- `packages/domain`: additional request tests only; the functions exist.

**Out of scope**:
- Web-side request creation (plan 009), sync (plan 010).
- Any new status value or transition.

## Git workflow

- Branch: `advisor/008-requests`
- Commit per step, short imperative messages (repo style).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Dev seeding + badge

- Dev tools screen: "Insert sample request" (uses domain `createRequest`
  with representative values incl. a W.I.F. line with item_name and a shared
  order_ref pair).
- Home screen Requests card shows the `countOpenRequests` badge; refresh on
  focus and after any request mutation (simple event-emitter or React Query
  invalidation — match whatever data-refresh pattern plans 004/006 used).

**Verify**: `pnpm -r typecheck` → exit 0.

### Step 2: Requests list + detail

`app/requests.tsx`: cards ordered as spec'd, grouped visually by `order_ref`
when consecutive lines share one; status chips
(pending/staging/fulfilled/declined). Detail sheet: full fields; actions per
status — pending: **Fulfill** / **Decline** (note dialog); staging:
**Resume staging** / **Cancel staging** (→ `setRequestStatus(id,"pending")`)
/ **Decline**; resolved: read-only with handler_note.
Decline calls `setRequestStatus(id, "declined", note)` and refreshes.

**Verify**: typecheck; simulator: seed → decline without note works; a
fulfilled row shows no actions.

### Step 3: Staging mode in Check Out + fulfillment

- Fulfill: `setRequestStatus(id, "staging")` then navigate to
  `/check-out?requestId=N`.
- Check-out screen in staging mode: banner with the request summary and a
  running staged total vs requested quantity; each scanned box's
  `CheckoutConfirmCard` (staged variant) adds a draw
  `{epc, amount, building: request.building}` to a local staged list
  (editable/removable) — **no `deliverUnits` call**.
- Buttons: **Confirm delivery** → `fulfillRequest(id, draws, note)`;
  on `note_required` show the shortfall dialog (message from the result) and
  retry with the note; on success show the summary and pop to the requests
  list. **Cancel staging** → `setRequestStatus(id, "pending")`, discard
  draws, pop.
- Leaving the screen without confirming keeps the request in `staging`
  (matching the PC app: the site shows "staging for exit"); the detail
  sheet's "Resume staging" re-enters with an empty staged list.

**Verify**: `pnpm -r typecheck` → exit 0; `expo export` → exit 0.
Simulator script: seed request qty 3 → fulfill → stage one box of 2 units →
Confirm → shortfall dialog demands note → add note → success; warehouse
drill-down shows the box Partial/Delivered; request card fulfilled with
"2 of 3 supplied — <note>".

### Step 4: Domain edge tests

Add to the plan-002 requests suite: staged draw against an EPC delivered
between staging and confirm → that draw fails but others commit (results
array reports it, db.py:1546-1555 semantics); cancel-staging leaves tags
untouched; `fulfillRequest` on an already-fulfilled request returns
`"Request #N is already fulfilled."`.

**Verify**: `pnpm --filter @rfid/domain test` → all pass.

## Test plan

- Step 4's three edge cases on top of plan 002's transition/rollback tests.
- Step 3's simulator script is the end-to-end check.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm -r typecheck` exits 0
- [ ] `pnpm --filter @rfid/domain test` exits 0 incl. new edge cases
- [ ] `pnpm --filter @rfid/field exec expo export --platform ios` exits 0
- [ ] `grep -rn "deliverUnits" apps/field/src/screens/checkout* apps/field/app/check-out.tsx | grep -i staging` → no matches (staging never commits directly)
- [ ] `grep -rn "coming soon" apps/field` → no matches (last placeholder gone)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The staged-draws flow seems to need a new request status or a schema
  column — it doesn't in the Python app; report the perceived gap.
- `fulfillRequest`'s transaction semantics can't be expressed with the
  domain's `withTransaction` helper (would indicate a plan-002 defect).
- UI state for staged draws survives navigation in a way that risks stale
  draws being confirmed (e.g. resume shows old draws) — the Python/browser
  behavior is empty-on-resume; report if that seems wrong rather than
  inventing persistence.

## Maintenance notes

- The transition table lives in `packages/domain` only; the UI derives
  available actions from the request's status via a single helper — a
  reviewer should reject status strings hard-coded in components.
- Plan 010 replaces the no-op "sync now" callback with the real push; the
  call sites added here (after decline/fulfill/cancel) are the integration
  points.
- Deferred: push notifications for new requests (plan 010 mentions them),
  partial-line fulfillment UI beyond the note flow.
