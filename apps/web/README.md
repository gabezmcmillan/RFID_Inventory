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

## Isolated dev Turso databases (wired through Vercel)

Production and Preview already have their own warehouse + auth Turso DBs —
**never reuse them for development**. This repo provisions two **isolated**
development databases — `rfid-warehouse-dev` and `rfid-auth-dev` — and wires them
through Vercel's **Development** environment so `vercel env pull` is the source
of truth for local env.

One-time setup (requires the Turso CLI, authenticated interactively):

```bash
# Install the Turso platform CLI if you don't have it:
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login            # opens a browser — the subagent cannot do this step

# Provision both dev DBs, migrate them, set Vercel Development env, merge locally:
bash scripts/setup-dev-turso.sh
```

The script:
- creates `rfid-warehouse-dev` and `rfid-auth-dev` (same Turso org/group; does
  not touch prod/preview DBs),
- applies the warehouse Drizzle migration bundle to `rfid-warehouse-dev`
  (`packages/domain/drizzle.dev.config.ts`) and the Better Auth migrations to
  `rfid-auth-dev` (`pnpm --filter @rfid/web auth:migrate`),
- sets **only** the Vercel **Development** env vars: `TURSO_DATABASE_URL`,
  `TURSO_AUTH_TOKEN`, `AUTH_DATABASE_URL`, `AUTH_DATABASE_AUTH_TOKEN`,
  `BETTER_AUTH_SECRET` (fresh dev-only value), `BETTER_AUTH_URL`
  (`http://localhost:3000`). The Microsoft Entra credentials are **not**
  overwritten — they were added to Development from your `.env.local` and stay
  as you set them. `AUTH_DEV_BYPASS` is deliberately **not** set in Vercel
  Development so real auth stays testable.

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
