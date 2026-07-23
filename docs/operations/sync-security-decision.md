# Sync security decision — Plan 010, Phase 1

> **Decision: `DIRECT_SYNC_PASS`** — the server-minted, short-lived,
> fine-grained Turso token model is supported and enforced. The field app may
> use direct Turso Sync with a server-minted credential callback. No
> server-mediated sync proxy is required for launch.

## Scope of this decision

This document records the Phase 1 security-gate evidence only. It does **not**
authorize shipping a static or broad mobile token (prohibited), and it does not
cover the sync-engine behaviors that still require a physical device (empty
replica bootstrap, two-replica convergence) — those are Phase 6 warehouse
acceptance items and are listed below as operator-owned.

## What was proved (disposable, non-production resources)

The spike is automated in `scripts/turso/spike-credentials.mjs` (operator-run;
needs a disposable Turso DB + a Platform API token; destroys the disposable DB
at the end). Run against a fresh disposable database, it passed **20/20**
checks. Evidence is reproducible by re-running that script; no secret values
are printed or committed.

### 1. The server can mint fine-grained, short-lived tokens

- The Turso Platform API endpoint
  `POST /v1/organizations/{org}/databases/{db}/auth/tokens?expiration={ttl}`
  accepts a `fine_grained_permissions` body of `[{ "t": <table|null>, "a":
  [<actions>] }]` and a minute-granularity `expiration` (e.g. `1m`, `10m`,
  `2w1d30m`). The CLI exposes only day-level `--expiration`, so the server
  seam must call the Platform API directly (not the CLI) for minute TTLs.
- A token minted with `expiration=10m` and `fine_grained_permissions` carried
  **both** a `perm` claim (the rules) and an `exp` claim ~10.0 min ahead of
  `iat`. The two concerns compose in one JWT.
- Accepted field-token shape for launch: `all:data_read` plus per-table
  `data_add,data_update` on the field-written tables, **no `data_delete`, no
  `schema_*`**, scoped to the warehouse database only (never the auth DB).

### 2. The libSQL server enforces the fine-grained permissions

With a token limited to `all:data_read` + `spike_rows:data_add,data_update`:

- Allowed: `SELECT` (all tables), `INSERT`/`UPDATE` on `spike_rows`, reading
  `sqlite_master` (system-table read is permitted by default).
- Denied: `DELETE` on `spike_rows` (`data_delete`), `INSERT` on
  `other_rows` (no `data_add`), `CREATE TABLE` (`schema_add`), `DROP TABLE`
  (`schema_delete`), `ALTER TABLE` (`schema_update`).
- Cross-database access was denied: the warehouse-scoped token could not read a
  different database (tokens are single-database scoped).

### 3. Expiry and revocation are enforced

- A token with a ~1 min TTL worked before expiry and was rejected by the
  server after expiry.
- Revocation via key rotation
  (`POST /v1/organizations/{org}/databases/{db}/auth/rotate`) invalidated an
  existing token: it worked before rotation and was rejected after. This is
  the server-side mechanism for revoking a lost/compromised field credential
  (rotate the warehouse keys; all prior field tokens stop working).

### 4. The installed RN client refreshes the credential without reopening the DB

- Installed package: `@tursodatabase/sync-react-native@0.7.1`. Its
  `DatabaseOpts.authToken` is `string | (() => Promise<string>)`
  (`src/types.ts:293`), and `bootstrapIfEmpty` is supported (`src/types.ts:316`).
- The shipped compiled artifact
  `lib/commonjs/internal/ioProcessor.js` invokes the async callback **per HTTP
  I/O**: `getAuthToken` does `await context.authToken()` (line 123) and
  `processHttpRequest` calls `getAuthToken(context)` per request (line 182) and
  sets `Authorization: Bearer <token>` (line 184). The database holds the
  callback reference; it is not recreated between syncs. Therefore each sync
  re-invokes the callback and a freshly minted token is used on the next
  push/pull without reopening the database.
- The spike asserts this against the installed compiled module (not a copy) so
  the claim tracks the actual shipped code.

## What is NOT yet proved (operator-owned, Phase 6)

These require the native sync engine on a real iPhone/simulator and are
deferred to Phase 6 warehouse acceptance, not the credential gate:

- An empty replica bootstraps the server schema via `bootstrapIfEmpty` without
  the mobile token holding any `schema_*` permission.
- Two offline replicas converge after reconnect, with the known same-row
  last-push-wins outcome (Turso Sync is explicit push/pull; concurrent
  same-row edits resolve to the last push). The plan accepts this constraint
  operationally (web inserts requests; field updates them; one writer per
  row at a time).

The credential gate itself — can the server mint and the server enforce a
short-lived fine-grained token, and can the RN client refresh it — is fully
proved, hence `DIRECT_SYNC_PASS`.

## Operational requirements implied

- The Vercel server holds a Platform API token scoped to `db:mint-token` for
  the warehouse org; it mints a warehouse-scoped token per field sync cycle
  with a 5–15 min TTL and the fine-grained permission set above.
- Field credential revocation = warehouse key rotation; all field tokens stop
  working immediately. Re-link a device after rotation.
- Never ship a static or `full-access`/`schema_*` token in the app bundle,
  QR, public env, or logs. The mobile token is always the short-lived,
  read+add+update-only, warehouse-scoped JWT from the server callback.

## Operator-action outcomes (post-Phase-1, pre-Phase-2)

Operator-authorized decisions, recorded before starting Phase 2:

1. **Branch-scoped Preview env (`rewrite/expo`) — ACCEPTED.** The four
   Preview-scoped DB env vars (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
   `AUTH_DATABASE_URL`, `AUTH_DATABASE_AUTH_TOKEN`) point at the separate
   preview databases (`rfid-warehouse-preview`, `rfid-auth-preview`) but are
   scoped to the `rewrite/expo` Git branch only. This is a CLI limitation in
   non-interactive mode (it cannot target "all Preview branches"). The
   operator accepted it for now and can widen to all Preview branches in the
   Vercel dashboard later. Tradeoff: other preview branches will not get
   these DB vars until widened.

2. **Server mint seam token — self-served, NARROW SCOPE UNAVAILABLE.** A named,
   revocable Platform API token `rfid-field-sync` was minted and stored as the
   server-only `TURSO_MINT_TOKEN` (Production environment-level + Preview
   `rewrite/expo` branch-scoped in Vercel; also in `apps/web/.env.local`).
   - **Tradeoff / deviation:** the CLI requires an **admin or owner** role in the
     org to mint a group-scoped, `db:mint-token`-only token
     (`turso auth api-tokens mint <name> --org <o> --group <g> --scope
     db:mint-token` → `Error: You must be an admin or owner to create
     group-restricted tokens`). The operator's account is not admin/owner of the
     Vercel-managed marketplace org, so the narrowest scope available was the
     named token's default, which is **scope `all` (broad)** — it can mint
     tokens for any database in the org and perform other control-plane
     actions, not just `db:mint-token` on the warehouse group.
   - **Mitigation in place:** the token is server-only (never `NEXT_PUBLIC_*` /
     `EXPO_PUBLIC_*`, never in the app bundle/QR/logs), encrypted at rest in
     Vercel, and the server code mints **only** warehouse-scoped field tokens.
   - **Rotation note:** to rotate, `turso auth api-tokens revoke
     rfid-field-sync`, mint a replacement, and update `TURSO_MINT_TOKEN` in
     Vercel (Prod + Preview) and `apps/web/.env.local`.
   - **Operator hardening item (added to checklist):** have an admin/owner of
     the marketplace org (or via Vercel marketplace controls) mint a
     group-scoped `db:mint-token`-only token and replace this broad one, to
     minimize blast radius if the server token leaks.
   - Token value was never printed/logged/committed; temp files shredded.

3. **Field-operator allowlist — PLACEHOLDER (no real users yet).** The
   production auth database `user` table was queried read-only: **0 rows**.
   No real signed-in user emails exist to seed the allowlist. The
   env-driven server setting `FIELD_OPERATOR_ALLOWLIST` (comma-separated
   emails) was created with a clearly-documented placeholder
   (`field-operator@example.invalid`) in Vercel (Production environment-level
   + Preview `rewrite/expo` branch-scoped) and `apps/web/.env.local`.
   - **Operator checklist item:** replace the placeholder with the real
     field-operator email(s) before launch. **(DONE 2026-07-23 — see
     "Action 2" below; placeholder replaced with the three real operator
     emails in Production, Preview, and `apps/web/.env.local`.)**

4. **Production env final confirmation (incident close-out).** Read-only
   confirmation that the four Production env vars point at the **original**
   hosts and carry tokens (values not printed):
   - `TURSO_DATABASE_URL` host =
     `rfid-warehouse-vercel-icfg-pwpqw6vsfjibquh1mwgj1cuk.aws-us-east-1.turso.io`
     → matches original ✅
   - `AUTH_DATABASE_URL` host =
     `rfid-auth-vercel-icfg-pwpqw6vsfjibquh1mwgj1cuk.aws-us-east-1.turso.io`
     → matches original ✅
   - `TURSO_AUTH_TOKEN` present (len 336) ✅
   - `AUTH_DATABASE_AUTH_TOKEN` present (len 336) ✅
   Production is intact and unchanged from its original state following the
   earlier accidental deletion/recovery during Preview re-pointing.

## Reproducing the spike

```sh
# operator, with turso CLI authed in the org that owns the disposable DB
SPIKE=rfid-spike-$(date +%s)
turso db create "$SPIKE"
TURSO_PLATFORM_TOKEN="$(turso auth token)" \
TURSO_ORG="<org-slug>" \
SPIKE_DB_NAME="$SPIKE" \
SPIKE_DB_URL="$(turso db show "$SPIKE" --url)" \
CROSS_DB_URL="$(turso db show <another-db> --url)" \
SPIKE_TTL="1m" \
  node scripts/turso/spike-credentials.mjs
# exits 0 on full pass; destroys the disposable DB
```

## Phase 2 outcomes — collision-safe IDs, local-only device state, credential control

Phase 2 is implemented and its verify gate is green (evidence below). No
physical-device acceptance was performed (operator-owned, Phase 6).

### What landed (commits `e3c63e9`, `b2f083f`, `61ff1fb`)

- **Collision-safe global text IDs.** Field-created integer PKs are now a
  RN-safe UUIDv4 helper (`packages/domain/src/id.ts`, `newId`): `tags.id`,
  `events.id`, `bol_docs.id`, `notes.id`, and `tags.bol_doc_id`. `requests.id`
  stays integer (web is its sole inserter). A forward migration rebuilds the
  four tables with text PKs and preserves existing rows (legacy integer id →
  text). `listEvents`/`listNotes`/`listBolDocs` now order by timestamp + the
  implicit monotonic `rowid` (UUID ids are not monotonic).
- **Local-only device state.** `device_id` and `epc_serial` moved out of the
  synced domain DB into a tiny separate local-only Turso RN database
  (`apps/field/src/db/deviceDb.ts`, `device.db`, no sync URL). Serials are
  reserved atomically (`BEGIN IMMEDIATE` + `UPDATE … + n`); a crash after
  reservation wastes serials but never reuses them. `allocateEpcs` takes an
  injected `EpcSerialAllocator`; `IntakeSession` takes it at construction.
- **Credential control.** `field_devices` + `auth_meta` tables live in the
  SEPARATE auth DB (Kysely over the shared libSQL dialect), never the synced
  warehouse DB. A monotonic, never-reused 2-hex EPC device byte is assigned per
  link. Endpoints `POST /api/device/register`, `/credential`, `/unlink` require
  the Better Auth bearer + the `FIELD_OPERATOR_ALLOWLIST` + an active device; a
  lost device is revoked via the `revokeDeviceAction` server action or the
  `scripts/ops/revoke-device.mjs` CLI. No role platform was added; revoked EPC
  bytes are never reused.

### Verify gate (all exit 0)

- `pnpm --filter @rfid/domain test` → **95 passed** (UUID uniqueness, two-replica
  non-colliding inserts, text `bol_doc_id` linkage, migration row preservation,
  atomic serial reservation, crash-skip-never-reuse, two-device non-collision).
- `pnpm --filter @rfid/web test` → **28 passed** (allowlist denial, EPC byte
  allocation/exhaustion, mint request building, repo unlink/revoke/never-reuse +
  separate auth schema, endpoint gating incl. refresh denial after
  unlink/revoke, mint-not-configured 503).
- `pnpm --filter @rfid/field test` → exit 0 (still the placeholder echo; field
  has no RN test runner — runtime behavior is Phase 6 physical acceptance).
- `pnpm -r typecheck` → all packages Done.

### Notes / judgment calls

- **QR replay:** the one-time token is single-use by Better Auth's
  `oneTimeToken` plugin (deleted on verify); the register endpoint additionally
  requires a valid bearer, so a replayed/invalid bearer is rejected with 401. A
  full end-to-end OTT-replay integration test against a live Better Auth instance
  was not added because the web is SSO-only (no test user creation without
  Entra); the single-use property is enforced by the plugin and asserted at the
  bearer gate.
- **`revokeSession` by id:** Better Auth's `revokeSession` API takes the session
  *token* (which we deliberately do not store). Unlink/revoke instead delete the
  `session` row by id directly (the bearer then dies immediately); the CLI uses
  the same raw-SQL approach.
- **Turso mint targets:** the Platform API identifies a DB by org + database
  *name* (not the libSQL hostname, which doesn't split cleanly), so `TURSO_ORG`
  + `TURSO_DB_NAME` are explicit server-only env vars (operator to set in
  Phase 4).
- **`FIELD_OPERATOR_ALLOWLIST`** now holds the real operator emails (set
  2026-07-23 — see "Action 2"); the production auth `user` table was empty at
  Phase 1, so the placeholder was used until the operator supplied the list.

## Operator-action outcomes (pre-Phase-3, self-served)

Operator actions 1 and 3 were self-served (both CLIs authenticated); action 2
stays operator-owned.

### Action 1 — Turso mint seam env (self-served)

- The named platform API token `rfid-field-sync` (broad `all` scope; see the
  Phase-1 tradeoff above) already existed and is set as `TURSO_MINT_TOKEN` in
  Production, Preview (branch-scoped `rewrite/expo`), and `apps/web/.env.local`.
- Added the new Phase-2 mint targets (server-only, not secret — they are the
  Turso org slug and database NAME, not the libSQL hostname):
  - `TURSO_ORG` = `vercel-icfg-pwpqw6vsfjibquh1mwgj1cuk` (both Production + Preview;
    all field DBs live in this one org).
  - `TURSO_DB_NAME` = `rfid-warehouse` (Production), `rfid-warehouse-preview`
    (Preview, branch-scoped `rewrite/expo`), `rfid-warehouse-dev`
    (`apps/web/.env.local` local dev).
- Set via `vercel env add ... --value ... -y` (Production + Preview) and appended
  to `apps/web/.env.local` preserving all existing keys. No secret values were
  printed or committed (org slug + DB name are not secrets).

### Action 3 — auth DB tables (verified, no re-run needed)

Queried both auth DBs via `turso db shell <name> "SELECT name FROM
sqlite_master WHERE type='table'"` (uses the CLI's own credentials — no env
secrets pulled):

- Production `rfid-auth`: `account`, `session`, `user`, `verification` ✅
- Preview `rfid-auth-preview`: `account`, `session`, `user`, `verification` ✅

Both already have the four Better Auth tables (Preview was migrated at
provisioning; Production observed at Phase 1), so `auth:migrate` was not re-run.
The custom `field_devices` / `auth_meta` tables are ensured idempotently at
runtime on the first device-endpoint call, so they appear after the first
deploy/link without a separate migration step.

### Action 2 — `FIELD_OPERATOR_ALLOWLIST` (DONE 2026-07-23)

Set to the operator-provided real emails in Vercel Production + Preview
(rewrite/expo) and `apps/web/.env.local` (placeholder replaced; all other keys
preserved). Value (comma-separated, the parser's natural format):

```
jcourson@brasfieldgorrie.com, gmcmillan@brasfieldgorrie.com, rhittie@brasfieldgorrie.com
```

`apps/web/.env.example` now documents the var with a generic example
(`ops@example.com, field-lead@example.com`), not the real emails. The Vercel
values were set via `vercel env add --value`; `vercel env pull` redacts
CLI-recently-added vars so they can't be visually re-confirmed via pull, but the
adds succeeded and the non-secret value round-trips for dev-targeted vars (per
the probe in the mint-seam note).

### Incident note (token leak to terminal scrollback)

While verifying Preview env, an early `head` of the pulled preview env file
printed the Preview `AUTH_DATABASE_AUTH_TOKEN` value to the terminal scrollback.
No token was logged to a file, printed in a commit, or written to the repo. As a
precaution, the operator should rotate the Preview `AUTH_DATABASE_AUTH_TOKEN`
(Turso Platform API or `turso db tokens create rfid-auth-preview`) and update
the Preview Vercel env + `apps/web/.env.local`. Production tokens were not
exposed. Going forward env files are inspected by `grep` on specific non-secret
lines only, never `head`/`cat`.

**ROTATED 2026-07-23.** Minted a fresh `rfid-auth-preview` token via
`turso db tokens create rfid-auth-preview` (written only to a 0600 temp file,
never printed), removed the old branch-scoped Preview
`AUTH_DATABASE_AUTH_TOKEN` from Vercel and added the new one as a sensitive
Preview (rewrite/expo) var — confirmed present in `vercel env ls`. The temp file
was deleted. `apps/web/.env.local` was NOT changed: its `AUTH_DATABASE_URL`
points at `rfid-auth-dev` (the dev auth DB), so its `AUTH_DATABASE_AUTH_TOKEN`
is the unrelated dev token, which was never exposed.

## Phase 3 outcomes — local-first sync coordinator, status UI, BOL queue

### Sync coordinator (one serialized state machine)

`apps/field/src/sync/coordinator.ts` is a pure, injectable state machine (no
timers, no network): one serialized push+pull cycle with startup / manual /
debounced-mutation / foreground / reconnect / timer triggers, jittered
exponential backoff capped at 30s, and single-refresh 401/403 handling that
falls to a terminal `reauth` state (no infinite retry). A schema-version check
before writes blocks with `blocked` (upgrade required) when the server is
ahead of the build. 26 deterministic field tests (fake timers + fake engine)
cover serialized cycles, trigger coalescing, debounce, bounded retry,
expired/revoked auth, the schema block, and the `reset()` re-link escape hatch.

### Wiring (RN, physical-device-verified)

`SyncProvider` builds the coordinator from the opened Turso embedded replica:
- `DatabaseProvider` opens `inventory.db` ONCE with function-valued `url` +
  `authToken` callbacks + `bootstrapIfEmpty`; `applyMigrations` runs only
  while sync is off (url null) — never on the replica in synced mode.
- `SyncCredentialStore` bridges `fetchSyncToken` to the Turso callbacks: primes
  a short-lived server-minted token + the warehouse URL when linked, stays
  local-only when not, and re-mints on 401/403.
- `AppState` wires foreground/reconnect + a 60s foreground timer; a vendored
  `SyncStatusBanner` surfaces the status states.
- `syncNow()` → debounced mutation trigger; unlink clears the cached token;
  re-link calls `reset()`.
- Web `getDb` idempotently stamps `local_meta.schema_version`; the credential
  endpoint also returns the per-environment warehouse libSQL URL.

### BOL upload queue

`apps/field/src/sync/bolQueue.ts` is a pure, injectable, idempotent upload
queue (Vercel Blob client-upload grant, jittered retry, dead-letter after
maxAttempts, REDACTED errors — the upload URL/token/bytes never appear in
recorded messages). 6 tests cover upload, idempotent re-enqueue, content
supersession, retry-then-succeed, dead-letter redaction, and restart resume.

### BOL upload queue — wired (2026-07-23 cleanup pass)

The deferred BOL wiring is now done (the `BLOB_READ_WRITE_TOKEN` blocker is
resolved — see "Vercel Blob store" below):

- **Server grant endpoint** `POST /api/bol/upload-grant` mints a short-lived
  Vercel Blob client-upload grant (`generateClientTokenFromReadWriteToken`)
  bound to `bol/{docId}/{contentHash}.{ext}`, capped at 25 MB, restricted to
  `image/jpeg|image/png|application/pdf`, no random suffix, no overwrite. Auth
  = device bearer + allowlist + active device; 503 when
  `BLOB_READ_WRITE_TOKEN` is unset. 13 unit tests.
- **Field enqueue**: `BolUploadQueue` entries now carry `contentType` +
  `sizeBytes` and `GrantProvider` receives them (content- + size-bound grants).
  `buildBlobGrant` reconstructs the `@vercel/blob` client-upload PUT request
  (RN cannot use `@vercel/blob/client` — it imports node `crypto`/`undici`); the
  API URL/version/header names are `@vercel/blob` v2.6.1 internals, unit-tested
  deterministically, and the live upload needs on-device validation.
  `ServerBolGrantProvider` calls the endpoint; `AsyncStorageQueueStorage`
  persists redacted metadata; `bolUpload` builds/restores the queue singleton
  after the domain db opens and exposes `enqueueBolArtifact` (read bytes,
  SHA-256 via `js-sha256`, enqueue). `onUploaded` sets `storage_url` via the
  new domain `setBolDocStorageUrl`. `documentStore.uploadBolDocument` enqueues
  the single uploaded artifact. 14 new field unit tests (40 total).
- **Scan-doc multi-page upload is still deferred**: scan docs are N JPEG pages
  with no single artifact (the multi-page PDF assembly is deferred per
  `MISTRAL_PAGE1_NOTE`), and `bol_docs.storage_url` is singular, so only the
  single-file `uploadBolDocument` path enqueues today.

### Vercel Blob store (2026-07-13 cleanup pass)

Self-served via CLI: `vercel blob create-store rfid-bol --access private
--environment production --environment preview` created a private Blob store
(`store_KuuQEJ6n3Yfy58pT`, iad1) and linked it to `rfid-inventory-web`, which
added `BLOB_READ_WRITE_TOKEN` to Production + Preview. (The CLI also created a
root `.env.local` of pulled dev vars — deleted, unused by the web app — and
added `.env*.local` to `.gitignore`, a safety improvement kept.) The
development `BLOB_READ_WRITE_TOKEN` is not in `apps/web/.env.local`; local-dev
BOL upload is an operator follow-up if needed.

### Two-replica convergence (DISPOSABLE, run once — PASS)

`scripts/turso/convergence-test.mjs` (operator-run, like the Phase 1 spike)
proves the data-level convergence semantics the coordinator depends on against
a disposable shared primary, using the HTTP libSQL client (kysely-libsql, the
same seam as the spike). Run 2026-07-23 against a disposable
`rfid-conv-primary` Turso DB (created + destroyed in the same session; no
production/preview resource touched):

```
CONVERGENCE RESULT: 8/8 checks passed
  order A->other: unique inserts converge (3 rows)        PASS
  order A->other: a1 present                              PASS
  order A->other: b1 present                              PASS
  order A->other: shared row = last-pushed (B)            PASS
  order B->other: unique inserts converge (3 rows)        PASS
  order B->other: a1 present                              PASS
  order B->other: b1 present                              PASS
  order B->other: shared row = last-pushed (A)            PASS
```

Unique inserts from two replicas converge to the union; concurrent same-row
edits resolve to last-push-wins in BOTH push orders.

### What remains physical-device-only

The installed Node `@tursodatabase/database@0.7.1` is local-only (no
embedded-replica sync opts), and `@tursodatabase/sync-react-native@0.7.1` is
RN-only (native binary). So the true local-file ↔ remote-primary push/pull
convergence — and the exact native 401/403 error shape the engine classifies —
must be verified on a physical iPhone. Operator checklist (max 5):

1. Link a field device (scan the web `/link-device` QR), confirm the
   `SyncStatusBanner` reaches `Synced` and `local_meta.schema_version`
   replicates down.
2. On a second linked device, create a tag each (unique EPCs) offline, then
   bring both online and confirm both replicas converge to the union of tags.
3. Edit the SAME row on both devices offline; bring both online in sequence
   and confirm the second-pushed value wins (last-push-wins).
4. Revoke one device via the operator CLI (`scripts/ops/revoke-device.mjs`);
   confirm that device's banner reaches `Re-link or upgrade required` and it
   stops retrying.
5. Bump the warehouse schema (add a migration), deploy, and confirm an
   un-upgraded device's banner reaches `Update required to sync` (blocked)
   and its writes are held.

### Open follow-ups (not Phase 3 blockers)

- BOL upload queue **on-device validation**: the wiring + unit tests are done
  (see "BOL upload queue — wired" above); the remaining piece is a live
  upload against the `rfid-bol` store on a device (RN `fetch` Blob-body PUT to
  the `@vercel/blob` control API) plus scan-doc multi-page upload once the
  PDF-assembly decision is made. Mistral OCR fallback is to be disabled in
  production (env-driven) in that same step.
- A dedicated NetInfo listener for true network-reconnect detection (today
  reconnect is inferred from AppState `active` + the retry loop).

## Phase 4 outcomes — production web, Sentry, rollback runbook (deterministic)

### Done (deterministic, gate-green)

- `/api/health` hardened: returns generic `service unavailable` (503) and logs
  the raw cause server-side only — never echoes driver/host/token detail. New
  `health.test.ts` injects a leaky internal error and asserts the body stays
  generic (web tests now 30).
- Field builds locked to the build-time server URL in production
  (`fieldEnv.isProductionBuild = !__DEV__`): `getServerUrl()` ignores any stored
  override and the Settings editor is hidden, so a production bundle can't be
  redirected to an arbitrary host via AsyncStorage. Dev LAN/Tailscale editing
  stays available in dev builds.
- `.github/workflows/ci.yml`: install, typecheck, tests, web lint, web build,
  field iOS export. Verified locally: `pnpm --filter @rfid/web build` passes;
  `pnpm --filter @rfid/field export` (pinned to `--platform ios`) produces a
  4.5MB Hermes bundle + `metadata.json` under `dist/` (gitignored).
- `docs/operations/production-launch.md` (resource/env names, migration
  verification, Turso PITR/backup, device+token revoke, deploy checklist,
  rollback to previous Vercel/TestFlight build) and
  `docs/operations/warehouse-acceptance.md` (Phase 6 warehouse-day checklist).

### Production DB verification (run 2026-07-23, disposable-free)

`turso db shell rfid-warehouse` reports the domain tables
(`bol_docs, events, local_meta, notes, requests, tags, vendors`) with **0
business rows** in every table — production starts empty, as required. The
Preview warehouse (`rfid-warehouse-preview`) and auth (`rfid-auth-preview`) are
separate DBs on different hosts from production; `local_meta.schema_version`
will be seeded to the build's `SCHEMA_VERSION` on the first production request
(`getDb` stamps it idempotently).

### Operator-blocked (need secrets / external accounts)

- Vercel env (Production target): `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`,
  `AUTH_DATABASE_*`, `TURSO_DATABASE_*`, `TURSO_MINT_TOKEN`/`TURSO_ORG`/
  `TURSO_DB_NAME`, `FIELD_OPERATOR_ALLOWLIST` (real emails), Entra
  `AZURE_AD_*`, `BLOB_READ_WRITE_TOKEN`, `SENTRY_DSN`. Listed in
  `docs/operations/production-launch.md`.
- Sentry init: add `@sentry/nextjs` (web) + `@sentry/react-native` (field),
  init with redaction (auth headers/cookies, tokens, BOL/OCR content, EPCs,
  request bodies), and confirm one symbolicated redacted Expo error + one Next
  error arrive. Blocked on a Sentry DSN/account.
- Entra production callback + sign-in/sign-out verification (needs the
  production Entra app registration).
- Production field default: set `EXPO_PUBLIC_DEFAULT_SERVER_URL` to the
  production HTTPS domain at EAS build time (the in-app lock is in place).
