#!/usr/bin/env node
// Alias the Vercel-injected Turso *auth* env names onto the app-facing names
// the web app's env schema reads, at Development scope only.
//
// The Turso marketplace integration injects the auth-dev resource as
// `AUTH_TURSO_DATABASE_URL` / `AUTH_TURSO_AUTH_TOKEN` (the `--prefix AUTH_`
// form of Turso's base `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`). The app
// schema (`apps/web/src/lib/env.ts`) reads `AUTH_DATABASE_URL` /
// `AUTH_DATABASE_AUTH_TOKEN`, so we alias them. Values are piped to
// `vercel env add` over stdin — never printed, never on a command line.
//
// Idempotent: any existing Development-scoped value for the alias name is
// removed first, then re-added from the pulled temp file.
//
// Usage: node alias-dev-turso-env.mjs <pulledDevEnvFile>
//   where <pulledDevEnvFile> is produced by:
//   vercel env pull <file> --environment development --yes
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [, , pulledPath] = process.argv;
if (!pulledPath) {
  console.error("Usage: alias-dev-turso-env.mjs <pulledDevEnvFile>");
  process.exit(2);
}

// Source (Vercel-injected) -> destination (app-facing alias).
const ALIASES = [
  ["AUTH_TURSO_DATABASE_URL", "AUTH_DATABASE_URL"],
  ["AUTH_TURSO_AUTH_TOKEN", "AUTH_DATABASE_AUTH_TOKEN"],
];

// Parse KEY=VALUE (raw value after first `=`) from the pulled file.
const env = new Map();
for (const line of readFileSync(pulledPath, "utf8").split("\n")) {
  if (line.startsWith("#") || line.trim() === "") continue;
  const eq = line.indexOf("=");
  if (eq <= 0) continue;
  env.set(line.slice(0, eq).trim(), line.slice(eq + 1));
}

let set = 0;
for (const [src, dst] of ALIASES) {
  if (!env.has(src)) {
    console.error(`alias-dev-turso-env: source ${src} missing in pulled file — skipping ${dst}.`);
    continue;
  }
  const raw = env.get(src);
  // `vercel env pull` wraps every value in surrounding double quotes in the
  // pulled file (even Vercel's own VERCEL_OIDC_TOKEN). Strip one pair of
  // surrounding matching quotes so we store the clean value — matching how
  // the Turso integration stored the original TURSO_* vars (quote-free at
  // runtime). Without this, the alias would be stored with literal quotes
  // and the libSQL client would try to connect to `"libsql://..."`.
  let value = raw;
  if (
    value.length >= 2 &&
    ((value[0] === '"' && value[value.length - 1] === '"') ||
      (value[0] === "'" && value[value.length - 1] === "'"))
  ) {
    value = value.slice(1, -1);
  }
  // Idempotent: drop any existing Development value for the alias, then add
  // from stdin (value stays out of shell history / `ps`).
  spawnSync("vercel", ["env", "rm", dst, "development", "-y"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const res = spawnSync("vercel", ["env", "add", dst, "development", "-y"], {
    input: value,
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (res.status !== 0) {
    console.error(`alias-dev-turso-env: vercel env add ${dst} failed (exit ${res.status}).`);
    process.exit(res.status ?? 1);
  }
  set++;
  console.error(`alias-dev-turso-env: ${dst} <- ${src} (Development)`);
}
console.error(`alias-dev-turso-env: set ${set} alias(es) at Development scope.`);
