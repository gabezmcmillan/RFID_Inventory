#!/usr/bin/env node
// Safely merge Vercel-managed Development env vars into apps/web/.env.local.
//
// `vercel env pull` writes ALL Development vars to one file and would overwrite
// the user's local-only values (AUTH_DEV_BYPASS, comments, the user-entered
// Microsoft OAuth credentials, LOCAL_* paths) if pointed at .env.local directly.
// Instead, this script reads a pulled temp file and updates ONLY an allowlist of
// Vercel-managed keys in the target, preserving every other line verbatim
// (comments, blank lines, local-only keys, and the user's Microsoft values).
//
// Usage: node merge-vercel-env.mjs <pulledEnvFile> <targetEnvFile>
// Keys are never printed. Values are written as-is (no quoting added).

import { readFileSync, writeFileSync } from "node:fs";

// Only these are owned by Vercel (set by the dev-provisioning script). Microsoft
// credentials are user-entered (Vercel holds copies, but the local .env.local is
// the source of truth) and are deliberately NOT in this list.
const VERCEL_MANAGED = new Set([
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "AUTH_DATABASE_URL",
  "AUTH_DATABASE_AUTH_TOKEN",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
]);

const [, , pulledPath, targetPath] = process.argv;
if (!pulledPath || !targetPath) {
  console.error("Usage: merge-vercel-env.mjs <pulledEnvFile> <targetEnvFile>");
  process.exit(2);
}

// Parse KEY=VALUE from the pulled file (ignore comments/blank lines). Values are
// taken raw (everything after the first `=`), matching vercel env pull's format.
const pulled = new Map();
for (const line of readFileSync(pulledPath, "utf8").split("\n")) {
  if (line.startsWith("#") || line.trim() === "") continue;
  const eq = line.indexOf("=");
  if (eq <= 0) continue;
  const key = line.slice(0, eq).trim();
  if (!VERCEL_MANAGED.has(key)) continue;
  pulled.set(key, line.slice(eq + 1));
}

if (pulled.size === 0) {
  console.error("merge-vercel-env: no Vercel-managed vars found in pulled file.");
  process.exit(0);
}

// Read existing target lines (may not exist yet).
let targetLines = [];
try {
  targetLines = readFileSync(targetPath, "utf8").split("\n");
  // Drop a trailing empty element from the final newline so we don't grow a
  // blank line each run; we re-add a single trailing newline on write.
  if (targetLines.length && targetLines[targetLines.length - 1] === "") {
    targetLines.pop();
  }
} catch {
  targetLines = [];
}

// Replace allowlisted keys in place; track which ones we replaced.
const replaced = new Set();
const next = targetLines.map((line) => {
  // Skip comment lines and lines without `=`.
  if (line.startsWith("#")) return line;
  const eq = line.indexOf("=");
  if (eq <= 0) return line;
  const key = line.slice(0, eq).trim();
  if (VERCEL_MANAGED.has(key) && pulled.has(key)) {
    replaced.add(key);
    return `${key}=${pulled.get(key)}`;
  }
  return line;
});

// Append any allowlisted keys that weren't already present.
for (const [key, value] of pulled) {
  if (!replaced.has(key)) {
    next.push(`${key}=${value}`);
  }
}

writeFileSync(targetPath, next.join("\n") + "\n", "utf8");
console.error(
  `merge-vercel-env: updated ${replaced.size + (pulled.size - replaced.size)} key(s) ` +
    `([${[...pulled.keys()].join(", ")}]) in ${targetPath}; local-only values preserved.`,
);
