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
