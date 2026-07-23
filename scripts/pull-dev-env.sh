#!/usr/bin/env bash
# Pull Vercel Development env into a TEMP file (outside the repo) and safely
# merge only the Vercel-managed keys into apps/web/.env.local, preserving all
# local-only values (AUTH_DEV_BYPASS, comments, the user-entered Microsoft
# credentials, LOCAL_* paths). The temp file is removed afterward.
#
# Run from anywhere: `bash scripts/pull-dev-env.sh` (or `pnpm --filter @rfid/web pull:dev`).
# WARNING: never run `vercel env pull apps/web/.env.local ...` directly — it
# overwrites the whole file and would discard those local-only values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -t rfid-env.dev.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

echo "Pulling Vercel Development env to a temp file (not committed)…"
vercel env pull "$TMP" --environment development --yes

node "$ROOT/scripts/merge-vercel-env.mjs" "$TMP" "$ROOT/apps/web/.env.local"
echo "Done. apps/web/.env.local updated with Vercel-managed dev vars; local-only values preserved."
