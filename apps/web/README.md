# `@rfid/web` — warehouse jobsite/office site

Next.js 16 app (App Router, Turbopack). Better Auth + Microsoft Entra ID SSO,
Drizzle over Turso for the warehouse domain, a separate Turso auth database,
and a QR one-time-token device-linking flow for the field app.

See [`apps/web/.env.example`](./.env.example) for every env var and the typed
schema at [`src/lib/env.ts`](./src/lib/env.ts) (boot fails loudly on bad config).

## Local dev

```bash
pnpm --filter @rfid/web dev          # http://localhost:3000
pnpm --filter @rfid/web typecheck
```

With **no** env vars set, the app runs fully offline: `BETTER_AUTH_SECRET`
absent ⇒ no auth backend (the `/api/auth` route 404s, `getUser()` returns `null`,
pages redirect to `/sign-in`), and `AUTH_DEV_BYPASS=1` short-circuits sign-in
with a fake dev user. The warehouse + auth databases default to local files in
`.dev-data/` (gitignored).

## Isolated dev Turso databases (provisioned through Vercel)

Production and Preview already have their own warehouse + auth Turso DBs —
**never reuse them for development**. This repo provisions two **isolated**
development databases — `rfid-warehouse-dev` and `rfid-auth-dev` — and wires them
through Vercel's **Development** environment so `vercel env pull` is the source
of truth for local env.

The dev resources are provisioned **entirely through the Vercel Marketplace
Turso integration** — no `turso auth login`, no Turso CLI. Vercel owns and
provisions both dev databases; their credentials are injected as
Development-scoped env vars and never touch the repo.

One-time setup (the Turso Marketplace terms must be accepted for the team that
owns the linked project — see the script output if they are not):

```bash
bash scripts/setup-dev-vercel.sh
```

The script is **idempotent** — it never destroys or recreates databases:

- It detects existing resources via `vercel integration list` and **reuses**
  them. `vercel integration add` is only run for a resource that does NOT yet
  exist (re-running `add` on an existing name opens a browser flow that tries to
  create a duplicate and errors out in the dashboard, so the script never does
  that).
- It provisions `rfid-warehouse-dev` (injects `TURSO_DATABASE_URL` +
  `TURSO_AUTH_TOKEN`) and `rfid-auth-dev` with `--prefix AUTH_` (injects
  `AUTH_TURSO_DATABASE_URL` + `AUTH_TURSO_AUTH_TOKEN`), both at **Development**
  scope only.
- It aliases the auth resource's injected names onto the app-facing names the
  env schema reads: `AUTH_DATABASE_URL` + `AUTH_DATABASE_AUTH_TOKEN`
  (`scripts/alias-dev-turso-env.mjs`, values piped over stdin — never printed).
- It applies the warehouse Drizzle migration bundle to `rfid-warehouse-dev`
  (`packages/domain/drizzle.dev.config.ts`, `dialect: "turso"`) and the Better
  Auth migrations to `rfid-auth-dev` (`pnpm --filter @rfid/web auth:migrate`).
- It sets **only** the Vercel **Development** env vars: `BETTER_AUTH_SECRET`
  (fresh dev-only value, generated only when missing so re-runs don't rotate
  it) and `BETTER_AUTH_URL` (`http://localhost:3000`). The Microsoft Entra
  credentials are **not** overwritten — they were added to Development from your
  `.env.local` and stay as you set them. `AUTH_DEV_BYPASS` is deliberately **not**
  set in Vercel Development so real auth stays testable.

> **Two-team gotcha:** this Vercel account has two teams, `brasfield-gorrie` and
> `brasfieldgorrie`. The linked project (`rfid-inventory-web`) lives under
> **`brasfieldgorrie`** (no hyphen). The script derives the owning team from
> `.vercel/project.json` and passes `--scope` to the integration commands, so
> the resources are provisioned under the correct team. (Provisioning under the
> wrong team fails to connect with `Project not found (404)`.)

### Refreshing local env

```bash
pnpm --filter @rfid/web pull:dev
```

This pulls Vercel Development env into a **temp file outside the repo** and
merges **only** the Vercel-managed keys into `apps/web/.env.local`, preserving
your local-only values (`AUTH_DEV_BYPASS`, comments, the user-entered Microsoft
credentials, `LOCAL_*` paths). See [`scripts/merge-vercel-env.mjs`](../../scripts/merge-vercel-env.mjs).

> ⚠️ **Never** run `vercel env pull apps/web/.env.local ...` directly — the
> Vercel CLI **replaces** the whole target file and would discard those
> local-only values. Always use `pull:dev` (the safe merge).

## Auth notes

- Sign-in route is `/sign-in` (not `/login`). A minimal `/login` → `/sign-in`
  redirect exists only because an external client (parked browser tab / Entra
  app-registration logout URL) still requests `/login`; no app code redirects
  there.
- `/link-device` requires a **real** Better Auth session (not the dev-bypass
  fake user). With the dev bypass active but no real session it renders a
  sign-in-required state instead of minting a token (which would otherwise
  throw `APIError: Unauthorized`).
- `BETTER_AUTH_URL` must match the origin the dev server is actually served
  on (default `http://localhost:3000`). If port 3000 is taken, Next picks
  another port and Better Auth rejects social sign-in/sign-out with
  `Invalid origin` (403) — free port 3000 or set `BETTER_AUTH_URL` to match.
