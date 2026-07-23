#!/usr/bin/env node
/**
 * Operator CLI: revoke a (possibly lost) field device (plan 010, Phase 2).
 *
 * Usage (run from the repo root, web env loaded):
 *   node --env-file=apps/web/.env.local scripts/ops/revoke-device.mjs <deviceId>
 *
 * Marks the device inactive + revoked (its EPC byte stays retired — never
 * reused) and deletes its Better Auth session row so the bearer dies
 * immediately. Talks directly to the auth DB (AUTH_DATABASE_URL +
 * AUTH_DATABASE_AUTH_TOKEN, or the local dev file) via the same libSQL client
 * the web app uses — no Better Auth instance needed.
 */

import { createClient } from "@tursodatabase/serverless";
import { resolve } from "node:path";

const deviceId = process.argv[2];
if (!deviceId) {
  console.error("Usage: node scripts/ops/revoke-device.mjs <deviceId>");
  process.exit(2);
}

const url = process.env.AUTH_DATABASE_URL;
const authToken = process.env.AUTH_DATABASE_AUTH_TOKEN;
const client = url
  ? createClient({ url, authToken })
  : createClient({ url: `file:${resolve(process.env.LOCAL_AUTH_DB_PATH ?? "../../.dev-data/auth.db")}` });

await client.execute(
  `CREATE TABLE IF NOT EXISTS field_devices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT,
    epc_byte TEXT NOT NULL UNIQUE, label TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, revoked_at TEXT, unlinked_at TEXT
  )`,
);

const now = new Date().toISOString();
const res = await client.execute({
  sql: `UPDATE field_devices SET active = 0, session_id = NULL, revoked_at = ?
        WHERE id = ? AND active = 1 RETURNING session_id`,
  args: [now, deviceId],
});

const rows = res.rows;
if (rows.length === 0) {
  console.error(`No active device found for id ${deviceId} (already inactive or unknown).`);
  await client.close();
  process.exit(1);
}

const sessionId = rows[0]?.session_id;
if (typeof sessionId === "string" && sessionId.length > 0) {
  await client.execute({ sql: `DELETE FROM session WHERE id = ?`, args: [sessionId] });
}

await client.close();
console.log(`Device ${deviceId} revoked. Its EPC byte is permanently retired.`);
if (sessionId) console.log(`Session ${sessionId} terminated.`);
