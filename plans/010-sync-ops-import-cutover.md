# Plan 010: Turso sync wiring, ops (EAS/Sentry/updates), data import + cutover

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Several steps here need operator-held
> credentials (Turso account, Apple developer account, Entra tenant, the
> production `inventory.db`); the plan marks them — implement everything
> around them and report what remains. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 79443fb..HEAD -- apps/field apps/web packages/domain plans`
> Plans 001–009 must be DONE in `plans/README.md` before starting; if not,
> STOP.

## Status

- **Priority**: P1
- **Effort**: M (code) + operator time (accounts, hardware validation)
- **Risk**: HIGH (production data migration and go-live)
- **Depends on**: plans 001–009 (all)
- **Category**: migration
- **Planned at**: commit `79443fb`, 2026-07-22

## Why this matters

Everything so far runs against local database files. This plan connects the
pieces: the field app syncs its local database to Turso Cloud (replacing the
entire custom sync layer — `apps/warehouse/sync.py`, `packages/contract`,
and the mirror logic in `apps/cloud/db.py`), BOL images upload to blob
storage, the apps get release/observability plumbing, and production data
moves over in a rehearsed, reversible cutover.

## Current state

- Field app opens its DB **local-only** (`apps/field/src/db/provider.tsx`,
  plan 004). `@tursodatabase/sync-react-native` supports adding
  `url` + `authToken` to `connect()` for bidirectional sync with explicit
  `push()` / `pull()`; offline writes queue in the local file.
- Web app reads env `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`
  (`apps/web/src/lib/db.ts`, plan 009).
- Importer CLI exists (`packages/domain/src/importer/cli.ts`, plan 002).
- The Python system is live: warehouse exe syncing to
  `apps/cloud/` on Vercel every 30 s (`apps/warehouse/sync.py:10-28`).
- Request handling in the field app calls a no-op "sync now" hook
  (plan 008); plan 005's QR URLs use the settings `cloud_base_url`.
- BOL docs carry `storage_url` (empty so far).

Sync-cadence spec being replaced (`apps/warehouse/sync.py`): every 30 s,
back off to max 300 s on failure, manual "sync now", offline is routine and
must never block local work. Reproduce the *cadence*, not the protocol.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck/tests | `pnpm -r typecheck && pnpm -r test` | exit 0 |
| Turso CLI (operator) | `turso db create rfid-inventory && turso db show rfid-inventory --url && turso db tokens create rfid-inventory` | url + token |
| Import (operator, rehearsal) | `pnpm --filter @rfid/domain exec tsx src/importer/cli.ts --from <copy-of-inventory.db> --to <local.db>` | counts match |
| Web deploy (operator) | `vercel deploy` from `apps/web` | build passes |
| Field build (operator) | `eas build -p ios --profile production` | build succeeds |

## Scope

**In scope**:
- `apps/field/src/sync/**` (sync service), db provider changes, settings
  (sync URL/token via `expo-secure-store`), device-id first-run screen
- `apps/field` ops config: `eas.json`, Sentry (`@sentry/react-native`),
  `expo-updates`
- `apps/web`: `/api/bol-upload` route (blob storage) + Sentry
- `packages/domain`: no new table — `bol_docs.storage_url` (empty vs set)
  is the upload-state marker; add a `pendingBolUploads(db)` query only
- `plans/CUTOVER.md` (the runbook — this plan writes it)

**Out of scope**:
- Deleting `apps/warehouse/`, `apps/cloud/`, `packages/contract/` — that
  happens in a follow-up commit **after** the runbook's success criteria
  hold for two weeks. This plan only writes the runbook step for it.
- Android.

## Git workflow

- Branch: `advisor/010-sync-ops-cutover`
- Commit per step; do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Sync service in the field app

`apps/field/src/sync/syncService.ts`:

- DB provider change: when settings contain `tursoUrl` + `tursoToken`,
  `connect({path, url, authToken})`; otherwise local-only as today. First
  connect with empty local file bootstraps from remote; keep
  `bootstrapIfEmpty: false` semantics so the app still opens with no
  network.
- `syncNow()`: `push()` then `pull()`, serialized (never concurrent),
  results recorded as `{lastSyncAt, lastError, online}` in a status store
  surfaced by the home-screen pill (mirrors the PC app's sync pill,
  `sync.py:85-90`).
- Cadence: run after every domain write (hook the repos' completion in the
  provider — a simple `onWrite` callback), on a 30 s foreground interval, on
  reconnect (`@react-native-community/netinfo`), and on app foreground.
  Failure backoff doubling to 300 s max (sync.py:122-123). Offline: writes
  proceed locally; the pill shows "N changes pending" is NOT reproducible
  (no watermark concept) — show "offline, will sync" instead.
- Replace plan 008's no-op sync-now hook with `syncNow`.
- First-run screen: if `local_meta.device_id` is `"01"`-default and
  `tursoUrl` is set, require the operator to pick a device id (01–FF,
  uniqueness is an operator responsibility documented on the screen) before
  minting any EPCs.

**Verify**: `pnpm -r typecheck` → exit 0; vitest for the backoff calculator
and the pendingBolUploads query; with two local simulator installs pointed
at one operator-provided Turso DB (operator step): check-in on device A
appears in device B's warehouse after both sync.

### Step 2: BOL image upload queue

- `apps/web/src/app/api/bol-upload/route.ts`: authenticated (session or a
  device bearer token env `DEVICE_UPLOAD_TOKEN`), accepts
  `{docId, filename, base64}` capped at 20 MB (sync.py:49), stores to Vercel
  Blob (`@vercel/blob`), writes the blob URL into that doc row's
  `storage_url`.
- Field app `apps/field/src/sync/bolUploadQueue.ts`: after each sync, for
  rows from `pendingBolUploads` (has local file, empty `storage_url`), POST
  to the web app's route; failures retry next cycle (self-healing like
  sync.py:19-24). Web `/tag/[epc]` + `/bol` links and the field docs screen
  cloud icon light up via `storage_url` (already rendered, plans 007/009).

**Verify**: typecheck; web route unit-testable part (validation) has a test;
end-to-end exercised in the runbook.

### Step 3: Ops plumbing

- `eas.json` with `development` / `preview` / `production` profiles;
  app config: bundle id (operator decides, placeholder
  `com.brasfieldgorrie.rfidinventory`), `expo-updates` enabled for OTA on
  the production channel, build number auto-increment.
- Sentry in both apps (`@sentry/react-native`, `@sentry/nextjs`), DSNs via
  env, wrapped error boundaries; no PII beyond device id.
- Document (in `plans/CUTOVER.md`, step 4) the Apple requirements: Apple
  Developer account, and TSL's **PPID** requirement for App Store submission
  of External Accessory apps (`asciiprotocol.com` states Apple submissions
  need TSL's PPID) — request it from TSL support early; TestFlight internal
  testing does not block on it.

**Verify**: `pnpm -r typecheck && pnpm -r test` → exit 0;
`pnpm --filter @rfid/field exec expo export --platform ios` → exit 0.

### Step 4: Cutover runbook (`plans/CUTOVER.md`)

Write the runbook with these phases, each with explicit success criteria:

1. **Provision** (operator): Turso DB + tokens; Vercel project for
   `apps/web` with env (Turso, Auth/Entra, Blob, Sentry, DEVICE_UPLOAD_TOKEN);
   EAS project; Sentry projects.
2. **Hardware validation** (operator, phone + sled + printer on warehouse
   wifi): pair Indium in SPP mode → `listAccessories` shows it (record the
   actual protocol string); trigger pull in check-in reads a tag; finder
   percent responds; print+encode one label → EPC reads back; VisionKit
   captures a real BOL and Mistral extraction prefills correctly.
3. **Rehearsal import**: copy production `inventory.db` → importer → point a
   TestFlight build + a preview web deploy at a **staging** Turso DB →
   verify counts (script: tags, events, per-type units vs the PC app's
   warehouse view) → run one full day in shadow mode (PC app remains
   authoritative; phone check-ins into staging only).
4. **Go-live** (a quiet morning): stop the warehouse exe (close the app);
   final import into the **production** Turso DB; verify counts; operator
   switches to the phone; jobsite users get the new web URL; old
   `rfid-inventory-sync` Vercel project set to redirect or a "moved" page.
   QR caveat: labels printed by the PC app carry the old domain — keep
   `/tag/{epc}` working by pointing the old domain at the new web app
   (domain alias), and confirm the new app's `cloud_base_url` setting is the
   new domain before printing.
5. **Rollback**: while the exe and `inventory.db` are untouched, rollback =
   reopen the exe and set the phone aside; any check-ins made on the phone
   in the gap must be re-entered (export them first via the events screen).
   Point of no return: first PC-app write after go-live data would diverge —
   the runbook forbids reopening the exe after go-live except as rollback.
6. **Retire** (after 2 weeks green): archive branch, delete
   `apps/warehouse/`, `apps/cloud/`, `packages/contract/`, update README.

**Verify**: `plans/CUTOVER.md` exists and covers all six phases with
success criteria (checklist form); `pnpm -r test` still green.

## Test plan

- Unit: backoff calculator, pendingBolUploads, upload-route validation.
- The real test is the runbook's phases 2–3; they are operator-executed and
  the executor's deliverable is the code + runbook that make them mechanical.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm -r typecheck && pnpm -r test` exit 0
- [ ] `grep -rn "push()\|pull()" apps/field/src/sync/syncService.ts` ≥ 2
- [ ] `grep -rn "expo-secure-store" apps/field/src` ≥ 1 (token not in AsyncStorage)
- [ ] `plans/CUTOVER.md` exists with the six phases
- [ ] `eas.json` with three profiles; Sentry init in both apps
- [ ] No file under `apps/warehouse/`, `apps/cloud/`, `packages/contract/` modified
- [ ] `plans/README.md` status row updated (and rows 001–009 verified DONE)

## STOP conditions

Stop and report back (do not improvise) if:

- Turso sync misbehaves in the two-device test (lost writes, conflict
  weirdness on the `requests` table) — this triggers the recorded escape
  hatch (`plans/README.md`: port the old HTTP exchange to TS) as a *decision
  for the operator*, not something to build unprompted.
- `@tursodatabase/sync-react-native`'s connect/push/pull API differs from
  what plan 004 wrapped — report the actual API.
- Any runbook phase can't be made mechanical (e.g. counts can't be verified
  scriptably) — fix the tooling, don't hand-wave the criterion.
- You are tempted to delete the Python apps now. Don't — phase 6 only.

## Maintenance notes

- The sync pill + Sentry are the two feedback channels for field problems;
  a reviewer should confirm sync failures are visible (pill) and reported
  (Sentry breadcrumb) but never block writes.
- Device-id assignment is manual (01–FF); if the fleet ever exceeds a
  handful of phones, build central assignment then.
- After phase 6, `plans/` should be archived with a final reconcile pass —
  the rewrite is complete and future work starts from a fresh audit.
