#!/usr/bin/env bash
# Provision TWO isolated DEVELOPMENT Turso databases, migrate them, set the
# Vercel DEVELOPMENT env, and merge into apps/web/.env.local.
#
# BLOCKER: requires `turso auth login` first (interactive, browser-based). The
# subagent could not complete this step non-interactively, so this script is the
# single command that finishes Task A once you are authenticated:
#
#   turso auth login          # one time, opens a browser
#   bash scripts/setup-dev-turso.sh
#
# It creates `rfid-warehouse-dev` and `rfid-auth-dev` (NEVER touches the existing
# production/preview warehouse + auth DBs), applies the warehouse Drizzle
# migration bundle to warehouse-dev and the Better Auth migrations to auth-dev,
# sets ONLY the Vercel Development env vars, then pulls+merges into .env.local.
# No secret values are printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.turso:$PATH"

WH_DB="rfid-warehouse-dev"
AUTH_DB="rfid-auth-dev"
BA_URL="http://localhost:3000"

echo "==> Checking Turso auth…"
turso auth whoami >/dev/null

# Optional: pin the group to match production by exporting TURSO_GROUP. Otherwise
# Turso creates in the default group.
GROUP_FLAG=""
if [[ -n "${TURSO_GROUP:-}" ]]; then
  GROUP_FLAG="--group ${TURSO_GROUP}"
fi

create_db() {
  local name="$1"
  if turso db show "$name" --url >/dev/null 2>&1; then
    echo "   $name already exists — reusing."
  else
    echo "   Creating $name…"
    turso db create "$name" $GROUP_FLAG -w
  fi
}

echo "==> Provisioning dev databases (isolated from prod/preview)…"
create_db "$WH_DB"
create_db "$AUTH_DB"

WH_URL="$(turso db show "$WH_DB" --url)"
AUTH_URL="$(turso db show "$AUTH_DB" --url)"
WH_TOKEN="$(turso db tokens create "$WH_DB")"
AUTH_TOKEN="$(turso db tokens create "$AUTH_DB")"
BA_SECRET="$(openssl rand -base64 32)"

echo "==> Applying warehouse Drizzle migrations to $WH_DB…"
TURSO_DATABASE_URL="$WH_URL" TURSO_AUTH_TOKEN="$WH_TOKEN" \
  pnpm --filter @rfid/domain exec drizzle-kit migrate --config drizzle.dev.config.ts

echo "==> Applying Better Auth migrations to $AUTH_DB…"
BETTER_AUTH_SECRET="$BA_SECRET" AUTH_DATABASE_URL="$AUTH_URL" \
  AUTH_DATABASE_AUTH_TOKEN="$AUTH_TOKEN" \
  pnpm --filter @rfid/web auth:migrate

set_vercel_dev() {
  # Idempotent: remove any existing Development-scoped value, then add from
  # stdin (never on the command line, so it stays out of shell history / ps).
  local name="$1" value="$2"
  vercel env rm "$name" development -y >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$name" development -y >/dev/null
}

echo "==> Setting Vercel DEVELOPMENT env vars (names only are reported)…"
set_vercel_dev TURSO_DATABASE_URL "$WH_URL"
set_vercel_dev TURSO_AUTH_TOKEN "$WH_TOKEN"
set_vercel_dev AUTH_DATABASE_URL "$AUTH_URL"
set_vercel_dev AUTH_DATABASE_AUTH_TOKEN "$AUTH_TOKEN"
set_vercel_dev BETTER_AUTH_SECRET "$BA_SECRET"
set_vercel_dev BETTER_AUTH_URL "$BA_URL"

echo "==> Pulling Vercel Development env and merging into apps/web/.env.local…"
bash "$ROOT/scripts/pull-dev-env.sh"

echo "==> Verifying tables (names only, no data)…"
echo "   $WH_DB tables:"
turso db shell "$WH_DB" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" \
  | sed 's/^/      /'
echo "   $AUTH_DB tables:"
turso db shell "$AUTH_DB" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" \
  | sed 's/^/      /'

echo
echo "Done. Vercel Development env now has (names only):"
echo "  TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, AUTH_DATABASE_URL,"
echo "  AUTH_DATABASE_AUTH_TOKEN, BETTER_AUTH_SECRET, BETTER_AUTH_URL"
echo "(MICROSOFT_* were already present in Development and were not changed.)"
echo "Refresh local env anytime with:  pnpm --filter @rfid/web pull:dev"
