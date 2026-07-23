# Plan 009: Web app — jobsite stock + cart, order status, tag pages, office browse, auth

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79443fb..HEAD -- apps/cloud apps/web packages/domain`
> If `apps/cloud/db.py` or `apps/cloud/app.py` changed since `79443fb`,
> compare the excerpts below against the live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/002-domain-package-schema-repos-importer.md (runs in parallel with 003–008)
- **Category**: migration
- **Planned at**: commit `79443fb`, 2026-07-22

## Why this matters

Jobsite users browse warehouse stock and submit material requests; office
staff need the warehouse view without a sled. Today this is
`apps/cloud/` — a FastAPI/Jinja app on Vercel reading a Postgres **mirror**
fed by a custom sync protocol, and it is deliberately public (its README
flags auth as a gap). The rewrite reads the **same Turso database** the field
app syncs to, deletes the mirror concept entirely, and puts real sign-in in
front of everything except the label-QR tag pages.

## Current state

- `apps/web` is the plan-001 Next.js skeleton (App Router, TS, `@rfid/domain`
  wired).
- `packages/domain` (plan 002) has schema + repos, incl. `createRequest` and
  `inventoryTree`. The jobsite-specific queries below are **not yet in
  domain** — this plan adds them there (so they're Node-tested), and the web
  app stays a thin rendering layer.

Behavioral spec from `apps/cloud/` (Python, the reference implementation):

**Stock rows for the cart** (`apps/cloud/db.py:436-527`): only stock with
`remaining > 0` is requestable. Plain types: one row per
item type × building, units summed across BOLs, with a BOL breakdown for
drill-down. Named types (any type whose in-stock boxes carry `item_name`,
i.e. W.I.F.): ONE row for the whole type whose drill-down is components —
one entry per component name × building with units/capacity/boxes/BOLs/
first-received/status (`"In Warehouse"` when units == capacity else
`"Partial"`, db.py:521-526) — and **the component is what gets requested**,
so requests carry `item_name`.

**Availability validation** (`apps/cloud/db.py:554-590`): quantity must
parse to a strict positive int (`None` → reject, never clamp,
db.py:140-147); available = `SUM(remaining)` for
(item_type, item_name, optional stock building); errors:
`"No {label} in stock{ in Building N} right now."` /
`"Only {n} unit(s) of {label} available…; requested {q}."`.

**Cart submission** (`apps/cloud/db.py:623-712`): one cart → N request rows
sharing a 6-hex uppercase `order_ref`, all-or-nothing. Per-line checks
(item type present, quantity valid, delivery building required), then
**aggregate** checks so two lines drawing on the same
(type, item_name, stock building) can't jointly exceed availability
(db.py:677-688). Errors return per-line `{line, message}`. Stored
`building` on each row = the line's **delivery** building.

**Order status page** (`apps/cloud/db.py:723-748`): requests grouped by
`order_ref` (legacy rows stand alone), open orders (any line
pending/staging) first, then newest; order-header building shown only when
all lines agree.

**Tag page** (`apps/cloud/app.py:196-215`): public QR landing —
`/tag/{epc}` shows the box's details and links its BOL document; printed
labels carry this URL (plan 005), so it must not require sign-in. Unknown
EPC → friendly "may not have synced yet" 404.

**Counts header** (`apps/cloud/db.py:539-551`): total units in warehouse +
open (pending/staging) request count.

**Timestamps**: web-created rows use UTC with explicit offset
(`apps/cloud/db.py:131-137` explains why); keep that convention for
`created_at` written by the web app.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm -r typecheck` | exit 0 |
| Domain tests | `pnpm --filter @rfid/domain test` | all pass |
| Web build | `pnpm --filter @rfid/web build` | exit 0 |
| Web dev server | `pnpm --filter @rfid/web dev` | serves on :3000 |

## Scope

**In scope**:
- `packages/domain/src/repo/webStock.ts` (new: stockRows, buildings, counts,
  listOrders, createCartRequest) + tests
- `apps/web/**` (all pages, auth, Turso client adapter)
- root `pnpm-lock.yaml`

**Out of scope**:
- `apps/cloud/**` stays deployed and untouched until plan 010's cutover.
- Turso cloud provisioning and env secrets (plan 010) — this plan develops
  against a **local file database** through the same adapter.
- BOL PDF serving (needs `storage_url` uploads from plan 010; render the
  link only when `storage_url` is non-empty).

## Git workflow

- Branch: `advisor/009-web-app`
- Commit per step, short imperative messages (repo style).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Jobsite queries in the domain package

Create `packages/domain/src/repo/webStock.ts` porting the five functions
above against `SqlDatabase` (SQLite dialect — the Python was Postgres; the
queries are plain aggregates and port directly; `COALESCE` works the same).
`createCartRequest` uses `withTransaction` and returns the exact shapes of
db.py:637-711 (`{ok, order_ref, ids, message}` / `{ok:false, message,
errors:[{line, message}]}`).

Vitest (seed tags via `receiveShipment` + draws via `deliverUnits` so the
data is realistic): plain-type row aggregates across BOLs; W.I.F. collapses
to one row with components; zero-remaining stock absent; cart with two lines
jointly exceeding one stock row → both lines errored; valid cart → rows share
an order_ref, `building` = delivery building; strict quantity ("2.5", "0" →
rejected); order grouping open-first.

**Verify**: `pnpm --filter @rfid/domain test` → all pass.

### Step 2: Web database adapter

`apps/web/src/lib/db.ts`: adapt Turso's client to `SqlDatabase`. Env-driven:
`TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` → `@tursodatabase/serverless`;
absent (local dev) → `@tursodatabase/database` on
`process.env.LOCAL_DB_PATH ?? "../../.dev-data/web.db"` with `applySchema` +
a seed script (`apps/web/scripts/seed-dev.ts`) inserting sample stock via
domain repos. One shared instance per server process.

**Verify**: `pnpm --filter @rfid/web exec tsx scripts/seed-dev.ts && pnpm --filter @rfid/web dev` → server starts; `curl localhost:3000/api/health` (add it: returns `{ok:true}` after a `SELECT 1`).

### Step 3: Pages

App Router pages, server components calling domain repos directly:

- `/` — stock browse + cart: table of `stockRows` (type, building, units,
  vendors, oldest received; drill-down of BOL groups / W.I.F. components),
  cart drawer (lines with per-line delivery building + quantity), checkout
  form (requester, contact, jobsite, note) → server action calling
  `createCartRequest`; per-line errors render against the offending lines
  (the `{line, message}` contract).
- `/requests` — `listOrders` grouped cards with status chips and
  handler_note when resolved; auto-refresh on focus.
- `/tag/[epc]` — public tag page as spec'd; "View bill of lading" link only
  when the doc row has `storage_url`.
- `/warehouse` — office view: reuse domain `inventoryTree` with the same
  group-by toggle + filters as the field app's warehouse screen, read-only.
- Shared header: counts (`counts()`), last-updated timestamp (max
  `tags.updated_at` — the mirror's "last synced" concept no longer exists).

**Verify**: `pnpm --filter @rfid/web build` → exit 0; with the dev seed:
submitting a 2-line cart creates 2 rows sharing an order_ref (check
`/requests`); an over-quantity line shows its error inline.

### Step 4: Auth (Better Auth, `effectivly` house style)

Use [Better Auth](https://better-auth.com) `1.6.18` (the exact version pinned in
the `effectivly` reference repo — same major + patterns), NOT Auth.js/NextAuth.
Remove the unused `next-auth` dependency from `apps/web/package.json`.

**Server instance (`apps/web/src/lib/auth.ts`):** a `makeAuth()` factory over
`betterAuth()`, env-driven. Built-in Kysely adapter (NOT
`@better-auth/drizzle-adapter`, which peers on `drizzle-orm ^0.45` while this
repo runs `1.0.0-rc` — the same version reason `effectivly` cites). The
`database` is a Kysely instance over a **separate** libSQL/Turso auth database:
`AUTH_DATABASE_URL` + `AUTH_DATABASE_AUTH_TOKEN` (Turso cloud) →
`@libsql/client` + the `@libsql/kysely` `LibSQLDialect`; absent → local file
`process.env.LOCAL_AUTH_DB_PATH ?? ../../.dev-data/auth.db`. `AUTH_SECRET` is
the Better Auth secret; `BETTER_AUTH_URL` is the public origin (required when
the auth backend is live, fails loud at boot otherwise — same as `effectivly`).
When `AUTH_DATABASE_URL` + `AUTH_SECRET` are both absent there is no auth
backend (`auth = null`, the offline gate `effectivly` uses). Microsoft Entra ID
social provider, env-driven and gated on both `MICROSOFT_CLIENT_ID` +
`MICROSOFT_CLIENT_SECRET`; `MICROSOFT_TENANT_ID` is required at boot when
Microsoft is set (throw, do not fall back to Entra's open `common` endpoint).
Configure `disableProfilePhoto: true`, `prompt: "select_account"`, and
`account.accountLinking.trustedProviders: ["microsoft"]` (the `effectivly`
settings). `session.cookieCache: { enabled: true, maxAge: 300 }`.

**Table/schema separation (architectural decision):** Better Auth's tables
(user/session/account/verification) are owned by Better Auth's own migrator
and live in the **separate auth database** above — they must NOT be added to
`packages/domain`'s schema (that schema is the warehouse domain synced to
phones; the field app must never see auth tables, and the web app writing auth
rows into the phone-synced Turso database would violate the multi-writer
discipline in `plans/README.md`). Auth schema/migrations are kept in
`apps/web`: `auth.config.ts` (the CLI entrypoint, like `effectivly`'s) plus
`auth:generate` / `auth:migrate` scripts using `@better-auth/cli`. Document this
separation in the plan and the README standing-decision bullet.

**API route (`apps/web/src/app/api/auth/[...all]/route.ts`):** the catch-all
`{ GET, POST }` from `toNextJsHandler(auth)` (`better-auth/next-js`); when
`auth === null` both verbs return 404 (the offline gate).

**Client (`apps/web/src/lib/auth-client.ts`):** `createAuthClient()` from
`better-auth/react` (same-origin against `/api/auth/*`); used by the sign-in
button and the header sign-out affordance.

**Session seam (`apps/web/src/lib/session.ts`):** keep the `getUser()` seam
(the stub that returned `null`). It now resolves the principal:
- **Dev bypass** (grep-able, one code path): when
  `process.env.AUTH_DEV_BYPASS === "1" && process.env.NODE_ENV !== "production"`
  → return a fake `{ name, email }` user (env-tunable via
  `AUTH_DEV_BYPASS_NAME` / `AUTH_DEV_BYPASS_EMAIL`, with defaults). The
  `NODE_ENV !== "production"` guard is on the same code path as `AUTH_DEV_BYPASS`
  so it is impossible to enable in prod.
- Otherwise → `auth === null` returns `null`; else
  `auth.api.getSession({ headers })` (via `next/headers`) mapped to
  `{ name, email }` or `null`.

**Routing gate (`apps/web/src/middleware.ts`):** require a session for
everything **except** `/tag/*`, `/api/health`, the auth routes (`/api/auth/*`),
and `/sign-in`. Use `getSessionCookie` from `better-auth/cookies` (cookie
presence, no DB hit — the Better Auth middleware pattern; `effectivly` gates
per-page instead, but this plan's Done criteria require a middleware matcher
that excludes `/tag`). When the dev bypass is active, middleware lets the
request through. The matcher must exclude `/tag` (grep `tag` in
`apps/web/src/middleware.ts` → 1+ match).

**Sign-in page (`apps/web/src/app/sign-in/page.tsx` + client form):** a single
"Continue with Microsoft" button (calls `authClient.signIn.social({
provider: "microsoft", callbackURL: "/" })`); when Microsoft is not configured
show a plain note. Redirect to `/` if the auth backend is offline.

**Prefill + sign-out:** the signed-in user's name/email prefill the checkout
form's requester/contact (the existing `Cart` already reads `user` from
`getUser()` — wire it through). Add a sign-out affordance in the shared header
(`Header.tsx`): a small client component calling `authClient.signOut()` then
pushing `/sign-in`; show the signed-in name/email from `getUser()`.

Env vars: `AUTH_SECRET`, `BETTER_AUTH_URL`, `AUTH_DATABASE_URL`,
`AUTH_DATABASE_AUTH_TOKEN`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`,
`MICROSOFT_TENANT_ID`, `AUTH_DEV_BYPASS`, `AUTH_DEV_BYPASS_NAME`,
`AUTH_DEV_BYPASS_EMAIL`, `LOCAL_AUTH_DB_PATH`. Tenant config may be
unavailable — wire env-driven and verify with the dev bypass; note the missing
tenant config in the report (plan 010's deploy step needs it).

**Verify**: `pnpm --filter @rfid/web build` → exit 0; dev with bypass: `/`
renders 200 with the fake user prefilled; without bypass: `/` redirects to
sign-in while `/tag/<seeded-epc>` still renders 200.

## Test plan

- Step 1's domain suite is the substance (≥8 cases listed there); model after
  plan 002's repo tests.
- Pages are verified by build + the seeded-dev manual script in steps 3–4.
  No E2E framework in this plan.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @rfid/domain test` exits 0 incl. `webStock` suite
- [ ] `pnpm -r typecheck` exits 0
- [ ] `pnpm --filter @rfid/web build` exits 0
- [ ] `grep -rn "next-auth" apps/web` → no matches (Better Auth replaces it)
- [ ] `grep -rn "AUTH_DEV_BYPASS" apps/web/src` shows the
  `NODE_ENV !== "production"` guard on the same code path (grep
  `NODE_ENV` near `AUTH_DEV_BYPASS`)
- [ ] `apps/web/src/middleware.ts` exists and its matcher excludes `/tag`
  (grep `tag` in `apps/web/src/middleware.ts` → 1+ match)
- [ ] `grep -rn "SELECT\|INSERT INTO" apps/web/src --include "*.ts" --include "*.tsx" | grep -v lib/db` → no matches (SQL only in domain)
- [ ] Better Auth tables are NOT in `packages/domain/src/schema.ts` (auth
  schema/migrations live in `apps/web` against a separate auth database)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `@tursodatabase/serverless` and `@tursodatabase/database` cannot share the
  adapter interface (report both API surfaces).
- A ported query behaves differently on SQLite vs the Python/Postgres
  original in a way a test exposes (e.g. NULL handling in `COALESCE`
  aggregates) — report; don't paper over with data changes.
- Entra ID provider setup requires tenant information you don't have — wire
  it env-driven, verify with the dev bypass, and note the missing tenant
  config in your report (plan 010's deploy step needs it).

## Maintenance notes

- The web app must never write to `tags` (multi-writer discipline in
  `plans/README.md`): it inserts `requests` rows and reads everything else.
  A reviewer should reject any `tags` mutation from `apps/web`.
- `webStock.stockRows` intentionally duplicates some `inventoryTree`
  aggregation with different shapes — they serve different UIs; do not
  unify them speculatively.
- Deferred: request cancellation by the requester; email/Teams notification
  on fulfillment; pagination beyond `LIMIT 100` on orders.
