#!/usr/bin/env bash
# Provision TWO isolated DEVELOPMENT Turso databases ENTIRELY through the
# Vercel Marketplace Turso integration — no `turso auth login`, no Turso CLI.
#
# Creates (if missing) and connects `rfid-warehouse-dev` and `rfid-auth-dev` to
# the linked Vercel project at the DEVELOPMENT scope only, maps the injected
# env names onto the app-facing names, sets dev-only Better Auth vars, pulls +
# merges into apps/web/.env.local, applies migrations, and verifies.
#
# IDEMPOTENT — never destroys or recreates databases:
#   * Existing resources are detected via `vercel integration list` and REUSED.
#     `vercel integration add` is only run for a resource that does NOT yet
#     exist — re-running `add` on an existing name opens a browser "additional
#     setup" flow that tries to create a DUPLICATE and errors out in the
#     dashboard ("An error occurred while creating …"). So we never re-add.
#   * BETTER_AUTH_SECRET is generated only when missing at Development scope
#     (re-runs do NOT rotate it). To force a fresh secret, `vercel env rm
#     BETTER_AUTH_SECRET development -y` first, then re-run.
#
# ONE-TIME PREREQUISITE — Turso Marketplace terms must be accepted for the team
# that owns the linked project. If not, the first `vercel integration add`
# prints `integration_terms_acceptance_required` with a URL — accept there (or
# run `vercel integration accept-terms tursocloud --yes`) and re-run this script.
#
# Usage: bash scripts/setup-dev-vercel.sh
# No secret values are printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WH_RESOURCE="rfid-warehouse-dev"
AUTH_RESOURCE="rfid-auth-dev"
AUTH_PREFIX="AUTH_"
BA_URL="http://localhost:3000"

echo "==> Resolving linked Vercel project + owning team…"
PROJECT_NAME="$(node -p "require('./.vercel/project.json').projectName")"
ORG_ID="$(node -p "require('./.vercel/project.json').orgId")"
TEAM="$(node -e '
  const { execSync } = require("child_process");
  const out = execSync("vercel teams ls --format json", { stdio: ["ignore", "pipe", "pipe"] }).toString();
  const i = out.indexOf("{");
  const teams = JSON.parse(out.slice(i)).teams;
  const t = teams.find((x) => x.id === process.argv[1]);
  if (!t) { console.error("No team found for orgId " + process.argv[1]); process.exit(1); }
  process.stdout.write(t.slug);
' "$ORG_ID")"
echo "    project: $PROJECT_NAME   team: $TEAM"

# List a resource's connected projects (empty array if none/missing).
resource_projects() {
  local name="$1"
  vercel integration list --all --scope "$TEAM" --format json 2>/dev/null \
    | node -e '
      let s = require("fs").readFileSync(0, "utf8");
      const i = s.indexOf("{");
      const data = JSON.parse(s.slice(i));
      const name = process.argv[1];
      const r = data.resources.find((x) => x.name === name);
      process.stdout.write(JSON.stringify(r ? r.projects : null));
    ' "$name"
}

# Provision one resource: create+connect only if missing; reuse if present.
provision() {
  local name="$1" prefix_flag="$2"
  local projs
  projs="$(resource_projects "$name")"
  if [[ "$projs" != "null" ]]; then
    if [[ "$projs" == *"\"$PROJECT_NAME\""* ]]; then
      echo "    $name already exists and is connected to $PROJECT_NAME — reusing."
      return
    fi
    echo "    $name exists but is NOT connected to $PROJECT_NAME."
    echo "    The CLI cannot connect an existing resource non-interactively."
    echo "    Open the Turso integration in the Vercel dashboard and connect"
    echo "    '$name' to '$PROJECT_NAME' (Development), then re-run this script."
    exit 1
  fi
  echo "    Creating + connecting $name (Development)…"
  # shellcheck disable=SC2086
  vercel integration add tursocloud/database --name "$name" \
    -e development --no-env-pull --scope "$TEAM" $prefix_flag \
    >/dev/null
  if [[ "$(resource_projects "$name")" != *"\"$PROJECT_NAME\""* ]]; then
    echo "    $name was created but did not connect to $PROJECT_NAME."
    echo "    If terms were just accepted, re-run this script."
    exit 1
  fi
}

echo "==> Provisioning dev Turso resources via the Vercel Marketplace…"
provision "$WH_RESOURCE" ""
provision "$AUTH_RESOURCE" "--prefix $AUTH_PREFIX"

echo "==> Pulling Development env to a temp file (for aliasing + checks)…"
TMP="$(mktemp -t rfid-setup.dev.XXXXXX)"
trap 'rm -f "$TMP"' EXIT
vercel env pull "$TMP" --environment development --yes >/dev/null

echo "==> Aliasing AUTH_TURSO_* -> app-facing AUTH_DATABASE_* (Development)…"
node "$ROOT/scripts/alias-dev-turso-env.mjs" "$TMP" >/dev/null

# Set a Development env var from stdin (idempotent: remove existing first).
set_vercel_dev() {
  local name="$1" value="$2"
  vercel env rm "$name" development -y >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$name" development -y >/dev/null
}

# Does a key exist at Development scope? (names only, never values.)
dev_env_has() {
  local name="$1"
  vercel env ls --format json 2>/dev/null \
    | node -e '
      let s = require("fs").readFileSync(0, "utf8");
      const i = s.indexOf("{");
      const envs = JSON.parse(s.slice(i)).envs;
      const name = process.argv[1];
      const hit = envs.some((e) => e.key === name && (e.target || []).includes("development"));
      process.stdout.write(hit ? "1" : "0");
    ' "$name"
}

echo "==> Ensuring dev-only Better Auth vars (Development)…"
# Secret: fresh only when missing (idempotent — re-runs do NOT rotate it).
if [[ "$(dev_env_has BETTER_AUTH_SECRET)" == "1" ]]; then
  echo "    BETTER_AUTH_SECRET already set in Development — keeping it."
else
  echo "    Generating fresh BETTER_AUTH_SECRET…"
  set_vercel_dev BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
fi
# URL is not secret; always (re)set to the local dev origin.
set_vercel_dev BETTER_AUTH_URL "$BA_URL"

echo "==> Pulling + merging Development env into apps/web/.env.local…"
bash "$ROOT/scripts/pull-dev-env.sh" >/dev/null

echo "==> Applying warehouse Drizzle migrations to $WH_RESOURCE…"
set -a; . "$ROOT/apps/web/.env.local"; set +a
pnpm --filter @rfid/domain exec drizzle-kit migrate --config drizzle.dev.config.ts

echo "==> Applying Better Auth migrations to $AUTH_RESOURCE…"
pnpm --filter @rfid/web auth:migrate

echo "==> Verifying tables (names only, no data)…"
pnpm --filter @rfid/web exec tsx "$ROOT/scripts/verify-dev-db.mjs"

echo
echo "Done. Vercel owns/provisions the dev Turso resources:"
echo "  $WH_RESOURCE, $AUTH_RESOURCE (Development scope only)."
# Single-quoted so the backticks are literal text, NOT command substitution.
# Never execute `turso auth login` or any Turso CLI from this script.
echo 'Direct `turso auth login` is NOT required.'
echo "Refresh local env anytime with:  pnpm --filter @rfid/web pull:dev"
