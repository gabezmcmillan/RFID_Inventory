# Production Launch Runbook

Plan 010. Operator-owned. This is the single checklist for cutting over to the
new field-sync stack. Production starts **empty** — there is no importer and no
legacy data work; the Python apps are reference-only until the post-acceptance
step.

## Resources (already provisioned — verify, do not recreate)

| Purpose | Turso DB | libSQL host |
| --- | --- | --- |
| Production warehouse | `rfid-warehouse` | `libsql://rfid-warehouse-vercel-icfg-…turso.io` |
| Production auth | `rfid-auth` | `libsql://rfid-auth-vercel-icfg-…turso.io` |
| Preview warehouse | `rfid-warehouse-preview` | `libsql://rfid-warehouse-preview-vercel-icfg-…turso.io` |
| Preview auth | `rfid-auth-preview` | `libsql://rfid-auth-preview-vercel-icfg-…turso.io` |
| Dev warehouse | `rfid-warehouse-dev` | `libsql://rfid-warehouse-dev-vercel-icfg-…turso.io` |

Vercel project: `BG-BGI/RFID_Inventory`, production branch `main`. Preview is
branch-scoped to `rewrite/expo` (and PRs) and points at the Preview DBs.

## Required Vercel env (Production target)

Add only what is missing; never copy Development values or expose a secret as
`EXPO_PUBLIC_*`:

- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (production HTTPS origin)
- `AUTH_DATABASE_URL`, `AUTH_DATABASE_AUTH_TOKEN` (production auth DB)
- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (production warehouse DB)
- `TURSO_MINT_TOKEN` (Platform API token `rfid-field-sync`), `TURSO_ORG`,
  `TURSO_DB_NAME=rfid-warehouse`
- `FIELD_OPERATOR_ALLOWLIST` (real operator emails)
- Entra: `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `AZURE_AD_TENANT_ID`,
  callback `https://<prod>/api/auth/callback/microsoft`
- `BLOB_READ_WRITE_TOKEN` (Vercel Blob, for BOL presigned upload grants; the
  `rfid-bol` store is **private** — uploads use presigned PUT, the tag page mints
  a presigned GET)
- `SENTRY_DSN` (web) and the field `SENTRY_DSN` baked as `EXPO_PUBLIC_*`? **No** —
  Sentry DSN is public-safe but keep it server-injected, not in the bundle.
  **(OPERATOR DECISION 2026-07-23: Sentry SKIPPED for launch — `SENTRY_DSN` is
  NOT required to launch. Add it post-launch; see
  `docs/operations/sync-security-decision.md` § "Sentry — SKIPPED for launch".)**

## Migration verification (before deploy)

1. `TURSO_DATABASE_URL=<prod> TURSO_AUTH_TOKEN=<prod> pnpm --filter @rfid/domain exec drizzle-kit migrate --config drizzle.dev.config.ts` → exit 0, no pending migration.
2. `turso db shell rfid-warehouse "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"` → `bol_docs, events, local_meta, notes, requests, tags, vendors`.
3. `turso db shell rfid-warehouse "SELECT COUNT(*) FROM tags"` (and each business table) → **0** (production starts empty).
4. `turso db shell rfid-warehouse "SELECT value FROM local_meta WHERE key='schema_version'"` → equals the build's `SCHEMA_VERSION` after the first production request seeds it.
5. `pnpm --filter @rfid/web auth:migrate` against the production auth DB → 4 Better Auth tables (`account, session, user, verification`).

## Turso backup / PITR

Turso keeps automated backups for cloud DBs. Confirm point-in-time restore
availability for `rfid-warehouse` in the Turso dashboard (or
`turso db create … --from-db rfid-warehouse --timestamp <ts>` for a PITR copy).
Record the restore contact / retention window here before launch:

- PITR contact / retention: ____________________
- Last pre-launch backup timestamp: ____________________

## Device / token revoke

- Lost/stolen device: `node scripts/ops/revoke-device.mjs <deviceId>` (marks
  inactive + revokes session; the phone's next sync goes `re-link required`).
- Rotate a DB's signing keys (invalidate all its minted tokens):
  `turso db tokens rotate <db>` (Platform API:
  `POST /v1/organizations/<org>/databases/<db>/auth/rotate`).
- Re-mint the platform mint token if `rfid-field-sync` is compromised:
  `turso auth api-tokens mint rfid-field-sync` and update `TURSO_MINT_TOKEN`.

## Deploy checklist (main)

1. Phase 1 decision doc shows `DIRECT_SYNC_PASS`.
2. Migrations current (above); production env/domain/Entra/backup green
   (Sentry SKIPPED for launch — not required).
3. CI green on the commit to merge.
4. Merge the reviewed `rewrite/expo` PR to `main`; Vercel Production deploys
   that commit (confirm the deployed SHA == `main` HEAD).
5. Install the accepted TestFlight build; record its build number below.
6. Create a few labeled smoke inventory records; sync; view on web; fulfill one
   request; print/read one tag; open one BOL. No import, no legacy reconciliation.

- Accepted `main` SHA: ____________________
- Accepted TestFlight build #: ____________________

## Rollback

If launch fails: stop the new app, revoke field devices, and return to the
**previous** Vercel deployment + TestFlight build. Preserve local unsynced data
for diagnosis; use Turso PITR only through this runbook.

- Previous Vercel deployment (Production) URL/SHA: ____________________
- Previous TestFlight build #: ____________________
- Rollback steps:
  1. In Vercel → Project → Deployments, promote the previous Production
     deployment (the one recorded above) to Production.
  2. In App Store Connect / TestFlight, roll back the field app to the previous
     accepted build (or release it as the current TestFlight build).
  3. `node scripts/ops/revoke-device.mjs <deviceId>` for each active field
     device, or rotate `rfid-warehouse` keys to invalidate all minted tokens.
  4. If warehouse data was corrupted, restore `rfid-warehouse` from the
     pre-launch PITR backup recorded above.
  5. Do NOT delete the failed deployment/build — preserve for diagnosis.
