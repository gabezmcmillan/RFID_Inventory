# Plan 010: Launch secure field sync and production apps

> **Executor instructions**: Follow the phases in order. Run each verification
> before continuing. If a STOP condition occurs, stop and report; do not expand
> this plan around the failure.
>
> **Drift check (run first)**:
> `git diff --stat d73717b..HEAD -- apps/field apps/web packages/domain scripts docs .github package.json pnpm-lock.yaml`
> Re-read the current-state locations below if any source path changed.
>
> **Fixed launch decisions**:
> - Production starts from the existing, migrated, empty Turso warehouse
>   database. There is no legacy data to import, reconcile, or dual-write.
> - Reuse the existing `rfid-inventory-web` Vercel project and its separate
>   Production/Preview warehouse and auth databases. Do not create replacements
>   or convert their direct encrypted env vars to Marketplace resources.
> - A static broad Turso token in the Expo app is prohibited.

## Status

- **Priority**: P1
- **Effort if the direct credential gate passes**: M — 7–12 engineering days
  plus one warehouse acceptance day
- **If the gate fails**: STOP and write a separate server-mediated-sync plan;
  this plan has no fallback implementation estimate
- **External elapsed time**: Apple signing/TestFlight review and TSL MFi/App
  Store approval can add days or weeks; that is not engineering effort
- **Risk**: HIGH at the credential and two-replica gates; MED after both pass
- **Depends on**:
  - Plan 009 web/auth behavior complete enough for production linking
  - Plan 011 physical-iPhone Tailscale check only for local phone-to-Mac testing;
    production never uses Tailscale
- **Category**: security, migration, tests, operations
- **Planned at**: commit `d73717b`, 2026-07-23
- **Status**: IN_PROGRESS — Phase 1 credential gate PASSED (`DIRECT_SYNC_PASS`); Phase 2 (collision-safe IDs, local-only device state, credential control) PASSED its verify gate; Phase 3 (local-first sync coordinator, status UI, BOL upload queue, two-replica convergence) PASSED its verify gate; Phase 4 deterministic code done (health hardening + test, production server-URL lock, CI workflow, launch/acceptance runbooks, web build + field iOS export verified, production DB verified empty with separate Preview hosts) — remaining Phase 4 (Entra/Sentry/Blob env, Sentry init, Entra callback) operator-blocked on secrets; Phases 5–7 pending
- **Operator scope addition (2026-07-23, authoritative)**: the device linker is
  the *setup* person, not necessarily the daily user. Three additions folded in
  and implemented in reviewable batches (commits below): (a) an offline-capable,
  required **device PIN** — salted PBKDF2-HMAC-SHA256 hash in `expo-secure-store`,
  set immediately after linking, required on launch and on return-to-foreground
  after a timeout, with retry backoff; the legacy AsyncStorage admin PIN is
  reconciled into the same hashed store (separate "admin" slot) so there is one
  PIN mechanism, not two; (b) **device registry lifecycle** — `field_devices`
  gained `last_seen_at`/`last_sync_at`/`deactivated_at`, the credential endpoint
  touches them on each mint, DEACTIVATE blocks credential refresh (pushes stop
  within the token TTL) and the field coordinator reacts to 403 by entering its
  terminal `reauth` state (no infinite retry), with unambiguous
  reactivate-vs-revoke semantics; (c) `linked_by` is tracked distinctly from
  "current user" and the admin UI says "Linked by", not "Owner". Web admin UI is
  a minimal shadcn page at `/admin/devices`. Tests cover PIN hash/verify/backoff,
  deactivate→refresh denial→coordinator stops, and registry fields.
- **Architecture cleanups (2026-07-23, operator-approved)**: independent
  reviewable batches on `rewrite/expo`, full gate green each, no push: (1) BOL
  upload replaced the reconstructed `@vercel/blob` internals with a server proxy
  `PUT /api/bol/upload` using the official server SDK `put()` (4 MB cap + field
  pre-flight; `access:public` so the tag-page link works) — **then (1b) superseded
  by the presigned-URL migration**: `POST /api/bol/upload-grant` mints a Vercel
  Blob presigned PUT (GA since `@vercel/blob@2.4.0`; repo on 2.6.1) scoped to the
  content-addressed pathname + 25 MB + content-type caps; the device plain `fetch`
  PUTs bytes directly to Blob storage (no SDK on-device, no serverless body cap);
  the private store is handled with `access:'private'` on the PUT and a
  short-lived presigned GET minted on the tag page (the proxy's `access:public`
  was a latent on-device bug on the private store); the proxy route is deleted;
  (2) web env parsing swapped to `@t3-oss/env-nextjs` `createEnv` (vars,
  cross-field refinements, and per-issue error ergonomics preserved); (3) Better
  Auth device-authorization plugin assessed and **not** migrated — no approval
  hook to bind register+EPC atomically, and its OAuth access token regresses the
  session-based revoke lifecycle; the custom QR/OTT flow is kept. See
  `docs/operations/sync-security-decision.md` for the full tradeoffs.
- **Sentry — SKIPPED for launch (operator decision, 2026-07-23)**: launch
  without error tracking; a recommended post-launch addition (redaction spec
  drafted). The Phase-4 Sentry operator-action item is annotated SKIPPED, not
  pending; no `@sentry/*` packages or `SENTRY_DSN` are required for launch. See
  `docs/operations/sync-security-decision.md` § "Sentry — SKIPPED for launch".

## Why this matters

The replacement apps exist, but the field database is local-only, `syncNow` is
a no-op, mobile/web test scripts are placeholders, and there is no EAS/Sentry
production setup. The shortest safe launch path is to prove short-lived mobile
credentials, remove replica ID collisions, add a small sync coordinator, verify
the infrastructure already provisioned, and test one real warehouse workflow.

## Current state

These facts were verified at `d73717b`.

- `apps/web/README.md:23-34` says Production and Preview already have separate
  warehouse/auth Turso databases; only Development uses Marketplace-managed
  `rfid-warehouse-dev`/`rfid-auth-dev`. Lines 67-72 name linked project
  `rfid-inventory-web` under team `brasfieldgorrie`.
- Commit `9d5dbe9` and `scripts/setup-dev-vercel.sh:1-15,93-100` confirm the
  Marketplace script is Development-only and reuses resources.
- Phase 1 verifies the deployment contract: `main` → Production,
  `rewrite/expo` → Preview; each target has direct encrypted warehouse/auth env
  pairs, different hosts, current migration journals, and empty Production
  business tables. Secret values are correctly absent from Git.
- `apps/field/src/db/provider.tsx:37-45` opens only
  `new Database({ path: getDbPath("inventory.db") })`, applies local migrations,
  and stores `device_id` in the domain database.
- `apps/field/src/sync/syncNow.ts:7-13` is a no-op. Installed
  `@tursodatabase/sync-react-native@0.7.1` accepts
  `url`, `authToken: string | (() => Promise<string>)`, and
  `bootstrapIfEmpty` (`node_modules/.../src/types.ts:279-316`); its `Database`
  exposes `push()`, `pull()`, `stats()`, and `checkpoint()`.
- `apps/field/src/auth/credential.ts:210-256` already exchanges the Better Auth
  QR token and stores its bearer in Secure Store; lines 281-286 unlink only
  locally. `apps/web/src/lib/auth.ts` keeps Better Auth separate and enables
  `oneTimeToken`/`bearer`.
- `packages/domain/src/schema.ts:28-75,88-114` gives field-created tags, events,
  BOL docs, and notes auto-increment integer IDs. Two offline replicas can
  collide; lines 140-147 put device ID/EPC serial in synced `local_meta`.
  Requests may keep integer IDs because only web inserts them. Turso Sync is
  explicit push/pull and last-push-wins for concurrent same-row edits.
- `apps/web/src/app/tag/[epc]/page.tsx:17-20,59-62` already promises a public
  BOL link when `storage_url` exists, requiring a minimal upload path.
- `apps/field/app.json` has the TSL External Accessory protocol and camera
  permission but no EAS project/runtime config or `eas.json`. Field/web tests
  are placeholders; no Sentry setup or tracked CI exists.

## Commands you will need

Run from the repository root. Never print or commit secret values.

| Purpose | Command | Expected |
|---|---|---|
| Baseline | `git status --short && pnpm -r typecheck && pnpm test` | only intended plan changes; exit 0 |
| Vercel project | `vercel project inspect rfid-inventory-web` | correct team/project; Production branch `main` |
| Env names | `vercel env ls production && vercel env ls preview` | required names present at the correct targets; values hidden |
| Domain migration | `TURSO_DATABASE_URL="<url>" TURSO_AUTH_TOKEN="<token>" pnpm --filter @rfid/domain exec drizzle-kit migrate --config drizzle.dev.config.ts` | exit 0; no pending warehouse migration |
| Auth migration | `BETTER_AUTH_SECRET="<shell-only>" AUTH_DATABASE_URL="<url>" AUTH_DATABASE_AUTH_TOKEN="<token>" pnpm --filter @rfid/web auth:migrate` | exit 0; auth DB only |
| App checks | `pnpm -r typecheck && pnpm test && pnpm --filter @rfid/web lint && pnpm --filter @rfid/web build` | exit 0; no placeholder tests |
| Field config | `pnpm --filter @rfid/field exec expo config --type introspect` | expected iOS plugins/protocols/permissions |
| Field export | `pnpm --filter @rfid/field exec expo export --platform ios --output-dir /tmp/rfid-field-export` | exit 0 |
| iOS CI build | `workflow_dispatch` → `.github/workflows/build-field-ios.yml` (needs `IOS_DIST_CERT_BASE64`, `IOS_DIST_CERT_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`, `BLOB_READ_WRITE_TOKEN`) | signed enterprise IPA → Vercel Blob; `/field/install` + `manifest.plist` serve OTA install |
| Final diff | `git diff --check && git status --short` | exit 0; only intended files |

## Suggested executor toolkit

- Use `better-auth-best-practices` for the credential/unlink endpoints.
- Use `vercel-react-best-practices` for web/React changes.
- Official docs: [Turso Sync](https://docs.turso.tech/sync/usage),
  [permissions](https://docs.turso.tech/sdk/authorization/fine-grained-permissions),
  [token API](https://docs.turso.tech/api-reference/databases/create-token),
  [Platform scopes](https://docs.turso.tech/api-reference/authentication),
  [Expo runtime](https://docs.expo.dev/eas-update/runtime-versions), and
  [Sentry Expo](https://docs.sentry.io/platforms/react-native/guides/expo/) /
  [Next](https://docs.sentry.io/platforms/javascript/guides/nextjs/).

## Scope

**In scope**:

- `packages/domain/**`: globally unique field-created IDs and migrations/tests
- `apps/field/**`: local device metadata, credential refresh, sync coordinator,
  status UI, BOL upload queue, Sentry, enterprise in-house iOS distribution +
  version check, focused tests
- `apps/field/**` (operator scope addition): offline-capable device PIN
  (salted PBKDF2 hash in `expo-secure-store`), lock gate (launch + foreground
  relock after timeout, retry backoff), reconciliation of the legacy admin PIN
  into the same hashed store, and the field-side 403 → reauth reaction
- `apps/web/**`: minimal field-device credential/revoke API, allowlist, Blob
  upload token route, generic health errors, Sentry, focused tests
- `apps/web/**` (operator scope addition): device registry lifecycle columns
  (`last_seen_at`/`last_sync_at`/`deactivated_at`), rename/deactivate/reactivate
  server actions + endpoints, credential-endpoint touch on mint, and a minimal
  shadcn admin devices page (`/admin/devices`) with "Linked by" copy
- `scripts/**` and `.github/workflows/ci.yml`: one DB check and one basic CI
- `docs/operations/{production-launch,warehouse-acceptance}.md`: two concise
  launch/rollback and one-day hardware checklists
- final post-launch mechanical archive paths in Phase 7

**Out of scope**:

- Creating/replacing Production or Preview Turso databases or changing their
  direct encrypted env ownership to Marketplace management
- Importers, legacy data migration, row reconciliation, or dual-write
- Broad RBAC/admin UI, generalized operation ledgers/conflict platforms,
  custom JWT crypto, or implementing server-mediated sync in this plan
- Extensive telemetry/evidence/drills or Mistral fallback
- Required Preview/Staging EAS profiles, multiple OTA channels, Expo OTA
  (`expo-updates`) JS updates, or Android; archiving Python before successful
  launch observation

## Git workflow

- Work from `rewrite/expo`; preserve unrelated changes.
- Use one reviewable commit per phase: `test(sync): prove short-lived Turso
  credentials`; `feat(sync): make field replicas collision-safe`;
  `feat(field): wire authenticated local-first sync`; `feat(ops): add production
  essentials`; `feat(field): enterprise in-house iOS distribution`; `docs(ops): record
  warehouse launch acceptance`; then the post-launch-only
  `chore(legacy): archive Python reference apps`.
- Do not commit secrets. Do not push/open/merge a PR without operator direction.

## Phases

### Phase 1: Verify existing resources and prove mobile credentials (1–2 days)

1. Run the drift/baseline commands.
2. Run Vercel project/env-name checks. Confirm `main` is Production,
   `rewrite/expo` has a Preview deployment, all four DB env names exist in each
   target, warehouse/auth hosts differ, and Development alone is Marketplace-
   managed. Reuse everything; do not provision or convert resources.
3. With securely supplied Production/Preview credentials, list table names and
   migration journals through the existing app drivers. Confirm warehouse/auth
   schemas are current and separate. Confirm Production business tables
   (`tags`, `events`, `vendors`, `bol_docs`, `notes`, `requests`) are empty.
4. On the existing Preview warehouse, using uniquely prefixed synthetic rows
   removed afterward by server-side Preview credentials, time-box a spike:
   - Vercel server holds a group-scoped Platform API token with only
     `db:mint-token`;
   - mint a warehouse-scoped token expiring in 5–15 minutes;
   - request only `all:data_read`, field-required add/update actions, no
     `data_delete`, no schema actions, and no auth DB access;
   - prove denied request insertion/schema mutation/other-database access;
   - prove the installed RN async `authToken` callback refreshes without
     reopening the database;
   - prove an empty replica bootstraps the server schema without mobile schema
     permission.
5. Record the sanitized outcome and exact accepted permissions/TTL in the
   security section of `docs/operations/production-launch.md`.

**Verify**: dedicated spike test exits 0 and the runbook says
`DIRECT_SYNC_PASS`. If the current Platform API cannot mint/enforce the required
fine-grained token, write `DIRECT_SYNC_UNSUPPORTED`, STOP, and request a separate
server-mediated-sync plan. Do not ship a full-access/static mobile token.

### Phase 2: Make IDs and device linking collision-safe

1. Change only field-created integer primary keys to one RN-safe global text-ID
   helper: `tags.id`, `events.id`, `bol_docs.id`, `notes.id`, and
   `tags.bol_doc_id`. Keep `requests.id` integer because web is its sole inserter.
2. Generate a forward migration and update repositories/types. Test fresh
   schema, existing-row preservation, foreign keys, and two-replica inserts.
3. Move `device_id` and `epc_serial` from the synced domain DB to a tiny separate
   local-only device database. Reserve each serial atomically before printing;
   crashes may skip but never reuse a serial.
4. Add only the auth state needed for credential control:
   - server env allowlist of field-operator emails;
   - minimal `field_devices` record in the auth DB (device UUID, user/session
     reference, permanently assigned two-hex EPC byte, active/revoked time);
   - QR link/register and credential endpoints require the existing Better Auth
     bearer plus allowlist and active device;
   - unlink marks the device inactive, revokes that session, then clears local
     Secure Store; add one operator CLI/action to revoke a lost device.
5. Do not add a role platform. Never reuse a revoked EPC device byte.

**Verify**:
`pnpm --filter @rfid/domain test && pnpm --filter @rfid/web test && pnpm
--filter @rfid/field test && pnpm -r typecheck` → exit 0. Tests cover UUID
collisions, migration/FKs, atomic serial reservation, allowlist denial, QR
replay, refresh denial after unlink/revoke, and separate auth/warehouse schemas.

### Phase 3: Wire the small local-first coordinator and BOL queue

1. Keep the raw Turso RN `Database` beside the Drizzle adapter. In production,
   bootstrap/pull the already-migrated remote schema; never push mobile DDL.
2. Implement one serialized cycle: `push()` then `pull()`. Trigger after startup
   readiness, manual **Sync now**, network reconnect, and app foreground.
3. Retry transient failures with a short bounded exponential schedule; refresh
   once on 401, then show re-link/revoked instead of looping.
4. Show only `syncing`, `synced + last time`, `offline/changes waiting`,
   `retrying`, and `re-link/upgrade required`. Compare the server schema version
   before writes; preserve local data and block writes when incompatible.
5. Document Turso's last-push-wins limitation. Preserve current writer
   discipline: web inserts requests; field updates them. Require a fresh pull
   before request fulfillment/destructive admin actions and operationally avoid
   two devices editing the same tag/request at once. Do not add an operation
   ledger unless the required two-replica test shows silent corruption beyond
   the known last-push-wins outcome; if it does, STOP and re-plan that conflict.
6. Because `/tag/[epc]` already displays `storage_url`, add a minimal persistent
   BOL upload queue using an authenticated, short-lived Vercel Blob client-upload
   grant. Key uploads by BOL doc ID/content hash, retry after reconnect, and set
   `storage_url` only after success. Disable Mistral fallback in Production.

**Verify**:
focused field/web tests pass for serialized cycles, triggers, bounded retry,
expired/revoked auth, offline write + force-close + restart + reconnect, schema
block, idempotent BOL retry, and redacted upload errors. A disposable two-replica
test proves unique inserts converge in both push orders and records the expected
same-row last-push-wins result.

### Phase 4: Finish production web, Sentry, and one rollback runbook

1. Verify/reuse the current Production/Preview env pairs and migrations. Add
   only missing Better Auth URL/secret, Entra tenant/client values, field
   allowlist/Turso mint settings, Blob, and Sentry vars at the correct target.
   Do not copy Development values or expose a secret as `EXPO_PUBLIC_*`.
2. Set the production field default to the production HTTPS domain and prevent
   arbitrary server URL editing in production builds. Tailscale stays dev-only.
3. Verify the exact Entra production callback and sign-in/sign-out. Make
   `/api/health` return generic status without raw exception text.
4. Add basic `@sentry/react-native` and `@sentry/nextjs` crash/error reporting
   with source maps. Redact auth headers/cookies, tokens, BOL/OCR content, EPCs,
   and request bodies; no replay is required. **(OPERATOR DECISION 2026-07-23:
   SKIPPED for launch — launch without error tracking; recommended post-launch
   addition. Redaction spec above is the draft for that future step. No
   `@sentry/*` packages or `SENTRY_DSN` are required for launch.)**
5. Write only two concise operational docs:
   - `production-launch.md`: resource/env names, migration verification,
     Turso backup/PITR availability, device/token revoke, main deploy checklist,
     and rollback to the previous Vercel/TestFlight build;
   - `warehouse-acceptance.md`: Phase 6 checklist.
6. Add one minimal CI workflow: install, typecheck, tests, web lint/build, and
   field export. Preview must use Preview DBs; Production remains `main` only.

**Verify**:
Production DB verification reports current separate schemas and zero business
rows; Preview points to different hosts; web build/field export pass; production
Entra works; health hides injected errors; one symbolicated redacted Expo error
and one Next error arrive in Sentry; rollback checklist names the previous
deploy/build and PITR contact/availability.

### Phase 5: Build and deploy the enterprise in-house IPA

> **Operator decision (2026-07-23):** the org can't use TestFlight, so Phase 5
> ships iOS via **enterprise in-house distribution** modeled on the `magnus`
> project — a signed `.ipa` uploaded to Vercel Blob and served to iPhones
> through a web install page + `manifest.plist` (`itms-services://`). No EAS,
> no TestFlight, no App Store submission. See
> `docs/operations/sync-security-decision.md` § "Phase 5 — enterprise in-house
> distribution" and `docs/operations/ios-ci-secrets.md`.

1. **CI build job** (`.github/workflows/build-field-ios.yml`, ported from
   `magnus/.github/workflows/build-mobile-ios.yml`): Expo CNG (`expo prebuild`)
   + raw `xcodebuild archive` / `-exportArchive` on `macos-15-xlarge`, Xcode 26
   pinned, manual signing with B&G's Apple Developer Enterprise cert (team
   `KDEGJ8G33R`, `iPhone Distribution: Brasfield & Gorrie, LLC`), a temporary
   keychain per run, `jq`-patched `app.json`, and provisioning-profile
   validation. **Single environment.** Bundle ID
   `com.brasfieldgorrie.rfid-field` (the checked-in `app.json` already uses it;
   CI re-states it authoritatively). Marketing version from `app.json`
   `expo.version`; **build number = the GitHub run number** (baked into
   `CFBundleVersion` = `Application.nativeBuildVersion`, which the field
   version-check compares against). `ExportOptions` `method: enterprise`.
   Required repo secrets: `IOS_DIST_CERT_BASE64`, `IOS_DIST_CERT_PASSWORD`,
   `IOS_PROVISIONING_PROFILE_BASE64`, `BLOB_READ_WRITE_TOKEN` (see
   `docs/operations/ios-ci-secrets.md`). The workflow is `workflow_dispatch`-
   triggerable and fails with a clear message when a secret is absent, so it is
   dry-runnable before the operator's `.p12` arrives.
2. **Deploy job**: downloads the IPA artifact and runs
   `apps/web/scripts/deploy-field-ipa.mjs`, which uploads the IPA to the
   private `rfid-bol` Blob store at `field-ios/{marketingVersion}/{buildNumber}.ipa`
   (`multipart: true`, `addRandomSuffix: false`, `allowOverwrite: true`,
   `access: 'private'`) and writes a small `field-ios/latest.json`
   (`{ buildNumber, marketingVersion, bundleId, displayName, ipaPath,
   uploadedAt }`). The store is **private** (verified), so the IPA is served to
   iOS via a short-lived presigned GET URL minted by the manifest route at
   install time — the read-write token never leaves the server/CI. This
   deviates from the original "public access for the IPA object" instruction
   because reusing the existing private store avoids a new cloud resource and a
   token-exposure risk; the deviation is documented in the decision doc.
3. **Web install surface** (no IPA ever proxied through a Next.js route):
   - `/field/install` page — public (a fresh phone has no session), **not
     listed in nav**; renders the `itms-services://` install button (pointing
     at the manifest route) plus human steps including the iOS 18+ first-install
     **Settings → General → VPN & Device Management → Brasfield & Gorrie, LLC →
     Allow & Restart** step and the `ppq.apple.com` reachability note.
   - `GET /api/field/manifest.plist` route — serves the OTA `manifest.plist`
     with `Content-Type: text/xml`; the `software-package` URL is a fresh
     presigned GET URL for the IPA in the private Blob store; includes
     `bundle-identifier` / `bundle-version` / `title`.
   - `GET /api/field/version` route — returns the latest `buildNumber` +
     install-page URL (read from `field-ios/latest.json` via a presigned GET).
4. **Field app version check**: on launch + app-foreground (with connectivity),
   fetch `GET /api/field/version`, compare `Application.nativeBuildVersion`
   to the fetched `buildNumber` (pure, deterministic logic in
   `apps/field/src/version/versionCheck.ts` with unit tests), and show a
   **non-blocking, dismissible banner** linking to `/field/install` when the
   installed build is older. `expo-application` is added as a field dependency
   for `nativeBuildVersion` (lazy-imported so the JS-only `expo export` and
   unit tests don't require the native binary).
5. **Defer Expo OTA (JS `expo-updates`)** to a follow-up — noted here as a
   recommended post-launch addition; not implemented in this phase. Native
   module/permission, credential-model, or incompatible schema changes still
   require a new binary (a new CI build + redeploy + re-install), since there
   is no OTA JS channel yet.
6. Replace field/web placeholder tests and run the full command set.

**Verify**:
config introspection, field export, all tests/typechecks, web lint/build, and
CI pass; the `build-field-ios.yml` workflow is `actionlint`-clean and
dry-runnable; the version-check compare/banner logic is covered by
deterministic unit tests; the `/api/field/version` and
`/api/field/manifest.plist` routes are covered by route tests; no
Turso/Better Auth/Entra/Blob secret is in the bundle. **Cannot be fully
validated until the operator's `.p12` + provisioning profile are added as repo
secrets** — the workflow fails clearly when they are absent, and a real signed
IPA + OTA install is the remaining unverified step.

### Phase 6: Accept in the warehouse, merge `main`, and launch

Use one real iPhone, TSL/Vulcan Indium sled, Zebra ZD621R, labels/tags, and a
non-sensitive BOL during one scheduled warehouse day. Use a second phone for one
physical conflict test if available; otherwise the automated two-replica gate
remains required.

1. Test clean in-house install/upgrade (via `/field/install` + `itms-services`,
   including the iOS 18+ Allow & Restart trust step on a fresh device), the
   field app's stale-build banner, Entra sign-in, QR link/replay denial,
   unlink/relink, and lost-device revoke.
2. Test sled connect/reconnect, check-in/out, sweep, find, printer status,
   print/encode/read-back, BOL scan/on-device OCR/upload/web link.
3. Test airplane mode writes, force-close/reopen offline, reconnect, manual sync,
   and web convergence. If two phones are available, concurrently create
   different tags and perform one controlled same-record last-push-wins test.
4. Complete `warehouse-acceptance.md`. Any safety/data-loss/hardware blocker is
   NO-GO.
5. Main merge checklist: approved Phase 1 decision, migrations current,
   Production env/domain/Entra/backup green (Sentry SKIPPED for launch), CI
   green, accepted commit and the deployed enterprise IPA build recorded,
   previous deployment/build rollback identified.
6. Merge the reviewed `rewrite/expo` PR to `main`; verify Vercel Production
   deploys that commit. Install the accepted enterprise build from `/field/install`.
7. Create only a few labeled smoke inventory records through the new field app;
   sync, view on web, fulfill one request, print/read one tag, and open one BOL.
   There is no import or legacy reconciliation.
8. If launch fails, stop the new app, revoke field devices, and return to the
   previous Vercel deploy + the previous enterprise IPA build (operators
   re-install the older build from `/field/install`). Preserve local unsynced
   data for diagnosis; use Turso PITR only through the runbook.

**Verify**:
warehouse checklist is fully PASS, `main` commit equals the Production deploy,
smoke workflow passes (Sentry SKIPPED for launch — no error-tracking gate), and
one normal warehouse shift completes successfully. Observe for two business days
before
Phase 7.

### Phase 7: Archive Python references after the launch window

In a separate mechanical commit after Phase 6 observation:

1. `git mv apps/warehouse archive/legacy-python/apps/warehouse`
2. `git mv apps/cloud archive/legacy-python/apps/cloud`
3. `git mv packages/contract archive/legacy-python/packages/contract`
4. Update root Python workspace/lockfile, README, and active path references.
   Do not refactor archived code.

**Verify**:
`pnpm test && pnpm -r typecheck && pnpm --filter @rfid/web build` → exit 0;
search shows no active build/test/deploy/import dependency on old paths; diff
shows mechanical moves in the separate archive commit.

## Test plan

- **Domain**: fresh migration, existing-row migration, global-ID/FK integrity,
  local atomic EPC serial, two-replica insert convergence.
- **Auth**: allowlist, bearer required, QR replay, active/revoked device,
  short-lived refresh, unlink/lost-device revoke, no auth DB access.
- **Sync**: serialized push/pull, four triggers, bounded retry, 401 refresh,
  offline restart/reconnect, schema mismatch, known same-row last-push-wins.
- **Device PIN + registry (operator scope addition)**: PIN hash/verify/backoff
  (PBKDF2, constant-time, lockout), lock-state reducer (launch + foreground
  relock after timeout), legacy-admin-PIN migration to the hashed store,
  deactivate → credential refresh denied (403) → coordinator stops, registry
  field presence (last_seen/last_sync/deactivated) and linked-by join.
- **BOL/web**: authenticated idempotent upload/retry, `storage_url` link,
  generic health errors, Sentry redaction.
- **Manual**: one warehouse day covering iPhone, sled, printer, camera/OCR,
  offline/reconnect, QR auth, in-house install + stale-build banner; second
  phone only if available.

## Done criteria

ALL must hold:

- [ ] Phase 1 records `DIRECT_SYNC_PASS`; otherwise this plan stopped
- [ ] no static/broad/write-capable Turso token or other server secret is in
      field source, public env, bundle, QR, logs, or Git
- [ ] existing `rfid-inventory-web` Production/Preview resources were reused;
      no duplicate DBs or Marketplace conversion was created
- [ ] Production warehouse/auth schemas are separate/current and business rows
      were zero before smoke launch
- [ ] field-created rows use global IDs; device ID/EPC serial are local-only
- [ ] two-replica insert/offline/reconnect tests pass and last-push-wins limits
      are documented/accepted
- [ ] unlink/lost-device revoke blocks credential refresh
- [ ] (operator scope addition) device PIN verifies fully locally (salted
      PBKDF2 hash in `expo-secure-store`, no network); the lock gate fires on
      launch and on return-to-foreground after a timeout; the legacy admin PIN
      is reconciled into one hashed-PIN mechanism (not two half-baked systems)
- [ ] (operator scope addition) deactivate blocks credential refresh (403) and
      the field coordinator enters its terminal reauth state (no infinite
      retry); reactivate-vs-revoke are unambiguous; the registry/admin UI shows
      "Linked by" (not "Owner") and the editable name, last-seen/last-sync, and
      active status
- [ ] BOL upload makes the current public tag-page link work
- [ ] field/web have real focused tests; full tests/typecheck/lint/build/export
      and minimal CI pass
- [ ] Production domain/Entra/health/Sentry/PITR/rollback checks pass
- [ ] `build-field-ios.yml` is actionlint-clean + dry-runnable; once the
      operator's `.p12` + provisioning profile are added as repo secrets, a
      signed enterprise IPA builds, deploys to Blob, and installs via
      `/field/install` + `itms-services` (incl. the iOS 18+ Allow & Restart
      trust step); the field app's stale-build banner fires on an older install
- [ ] reviewed `rewrite/expo` merges to `main`; that commit deploys Production;
      empty-launch smoke workflow and observation window pass
- [ ] Python archive happens only afterward in its own mechanical commit
- [ ] Plan 010 row in `plans/README.md` is DONE only after all criteria pass

## STOP conditions

- Direct fine-grained, short-lived Turso token mint/enforcement or RN refresh is
  unsupported; record the result and re-plan server-mediated sync separately.
- The mobile path needs a full-access/static token, schema permission,
  control-plane token, auth DB access, or custom JWT signing.
- Production/Preview DB pairs are missing, shared, stale, non-empty before smoke,
  or point at Development; verify before considering any replacement.
- Two-replica unique inserts still collide or lose rows after global IDs.
- The known same-row last-push-wins behavior is unacceptable to operations or
  produces corruption beyond the constrained workflow.
- Schema mismatch would require discarding unsynced local data.
- A secret appears in Git, logs, Sentry, or the mobile bundle; revoke it first.
- Real sled/printer/BOL/offline/in-house-install acceptance or required
  Apple/TSL approval is unavailable.
- A verification fails twice after one evidence-based fix, or source drift
  invalidates a load-bearing current-state claim.
- Anyone requests import, legacy reconciliation, dual-write, or pre-launch
  Python archiving.

## Post-launch / deferred
- If needed: server-mediated sync, broader RBAC/row authorization, or a general operation ledger/conflict resolution.
- Optional: richer telemetry/alerts, EAS channels, server-side Mistral OCR, and recurring backup/rotation drills.

## Maintenance notes
- Apply warehouse schema changes server-side before compatible clients pull;
  incompatible schema/native changes require a new app version.
- Keep token TTL/permissions, permission tests, and the runbook aligned.
- Re-run two-replica and hardware acceptance for sync-client/native upgrades.
- Keep archived Python as historical reference only; never restore an active dependency.
