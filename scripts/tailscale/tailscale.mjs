#!/usr/bin/env node
// Minimal Tailscale setup/doctor for local development.
// No npm dependencies — Node built-ins only.
//
//   node scripts/tailscale/tailscale.mjs setup   -> configure `tailscale serve` for localhost:3000
//   node scripts/tailscale/tailscale.mjs doctor  -> read-only verification (PASS/WARN/FAIL)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { discoverFieldOrigin, classifyServe, classifyFunnel } from "./parse.mjs";
import { resolveTailscaleCommand, fellBackFromPathToApp } from "./resolve.mjs";
import { readEnvKey, upsertEnvKey } from "./envfile.mjs";

const LOCAL_WEB = "http://127.0.0.1:3000";
const HEALTH_PATH = "/api/health";
const FETCH_TIMEOUT_MS = 3000;
const MAC_DOWNLOAD_URL = "https://tailscale.com/download/mac";
// The Expo env key the field app reads for its default server origin. Must stay
// in sync with apps/field/src/config/env.ts (kept duplicated here only because
// this script is plain .mjs and cannot import the TS module).
const FIELD_ENV_KEY = "EXPO_PUBLIC_DEFAULT_SERVER_URL";
const FIELD_ENV_FILE = path.join(
  path.resolve(import.meta.dirname, "../.."),
  "apps/field/.env.local",
);

// ---------------------------------------------------------------------------
// Command resolution: pick ONE `tailscale` binary and use it for every call.
// On macOS the Homebrew/PATH CLI and the GUI-app-bundled CLI talk to different
// daemons; the PATH CLI can fail to connect even when the Mac app is running.
// We prefer a candidate whose `status --json` actually connects, so GUI users
// don't need manual path commands. Never mix binaries.
// ---------------------------------------------------------------------------
function buildCandidates() {
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push({ path: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", source: "app" });
    candidates.push({
      path: path.join(homedir(), "Applications/Tailscale.app/Contents/MacOS/Tailscale"),
      source: "app",
    });
  }
  candidates.push({ path: "tailscale", source: "path" });
  return candidates;
}

// Probe one candidate: { exists, connects }. `connects` means the daemon is
// reachable (`status --json` exits 0); a signed-out-but-running daemon still
// exits 0, so connects != signed-in. Receives the candidate descriptor.
function probeCandidate(c) {
  const cmd = c.path;
  if (cmd !== "tailscale" && !existsSync(cmd)) {
    return { exists: false, connects: false };
  }
  const res = spawnSync(cmd, ["status", "--json"], { encoding: "utf8", maxBuffer: 1 << 24 });
  if (res.error) {
    return { exists: res.error.code !== "ENOENT", connects: false };
  }
  return { exists: true, connects: res.status === 0 };
}

function resolveCommand() {
  return resolveTailscaleCommand(buildCandidates(), probeCandidate);
}

function makeRunner(command) {
  return function runTailscale(args) {
    const res = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1 << 24 });
    if (res.error) {
      return { ok: false, missing: res.error.code === "ENOENT", error: res.error };
    }
    return { ok: res.status === 0, status: res.status, stdout: res.stdout, stderr: res.stderr };
  };
}

function parseJsonOr(text, fallback) {
  if (!text || !text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(t);
  }
}

function line(level, msg) {
  const tag = level === "PASS" ? "PASS" : level === "WARN" ? "WARN" : level === "FAIL" ? "FAIL" : "INFO";
  process.stdout.write(`${tag}  ${msg}\n`);
}

function sourceLabel(source) {
  return source === "app" ? "macOS app" : source === "path" ? "PATH" : "unknown";
}

// Upsert ONLY the field env default-origin key into apps/field/.env.local,
// preserving comments and other values. Never prints file contents. Ensures
// the file ends with a newline. Creates the file if absent.
function upsertFieldEnvOrigin(originUrl) {
  const prev = existsSync(FIELD_ENV_FILE) ? readFileSync(FIELD_ENV_FILE, "utf8") : "";
  let next = upsertEnvKey(prev, FIELD_ENV_KEY, originUrl);
  if (!next.endsWith("\n")) next += "\n";
  writeFileSync(FIELD_ENV_FILE, next, "utf8");
}

// Read the field env default-origin key (or null if file/key absent). Used by
// doctor to compare against the discovered origin. Never prints file contents.
function readFieldEnvOrigin() {
  if (!existsSync(FIELD_ENV_FILE)) return null;
  return readEnvKey(readFileSync(FIELD_ENV_FILE, "utf8"), FIELD_ENV_KEY);
}

// Resolve the binary, print install/open-vs-sign-in remediation on failure.
// Returns { run, command } or exits the process.
function resolveOrFail() {
  const r = resolveCommand();

  if (!r.anyExists) {
    line("FAIL", "tailscale CLI not found.");
    if (process.platform === "darwin") {
      line("INFO", `Install/open the Tailscale Mac app: ${MAC_DOWNLOAD_URL}`);
    } else {
      line("INFO", "Install Tailscale: https://tailscale.com/download");
    }
    process.exit(1);
  }

  // PATH CLI exists but can't connect while the Mac app works -> one INFO line,
  // not a false sign-in error.
  if (fellBackFromPathToApp(r)) {
    line("INFO", `PATH 'tailscale' could not connect; using the macOS app CLI instead.`);
  }

  if (!r.connects) {
    // A binary exists but no daemon is reachable -> open/start Tailscale, NOT sign in.
    line("FAIL", `Could not connect to the Tailscale daemon via ${sourceLabel(r.source)} CLI.`);
    if (process.platform === "darwin") {
      const appExists = r.probed.some((c) => c.source === "app" && c.exists);
      line("INFO", appExists
        ? "Open the Tailscale Mac app (so the daemon runs), then re-run."
        : `Install/open the Tailscale Mac app: ${MAC_DOWNLOAD_URL}`);
    } else {
      line("INFO", "Start tailscaled (e.g. `sudo tailscaled`), then re-run.");
    }
    process.exit(1);
  }

  return { run: makeRunner(r.command), command: r.command, source: r.source };
}

// Check Funnel state. Returns { state, reason } and prints FAIL for on/unknown.
// Returns true if safe to continue (Funnel off), false if setup must abort.
function checkFunnelOrFail(run) {
  const fr = run(["funnel", "status", "--json"]);
  const fun = classifyFunnel(parseJsonOr(fr.stdout, null), fr.ok);
  if (fun.state === "on") {
    line("FAIL", "Funnel is ON. Plan 011 uses the private tailnet only — Funnel exposes the node to the public internet.");
    line("INFO", "Remediation: `tailscale funnel off`, then re-run `pnpm tailscale:setup`.");
    return false;
  }
  if (fun.state === "unknown") {
    line("FAIL", `Funnel state could not be confirmed: ${fun.reason}.`);
    line("INFO", "Remediation: ensure Tailscale is running; if Funnel is on run `tailscale funnel off`, then re-run.");
    return false;
  }
  line("PASS", "Funnel is off (private tailnet only).");
  return true;
}

// ---------------------------------------------------------------------------
// SETUP
// ---------------------------------------------------------------------------
async function setup() {
  const { run } = resolveOrFail();

  const statusRes = run(["status", "--json"]);
  const status = parseJsonOr(statusRes.stdout, null);
  const origin = discoverFieldOrigin(status);
  if (!origin.ok) {
    line("FAIL", `Cannot derive Field API URL: ${origin.reason}.`);
    line("INFO", "Remediation: sign in with `tailscale up`, then re-run `pnpm tailscale:setup`.");
    process.exit(1);
  }

  // Funnel must be OFF before we touch Serve — never auto-disable it.
  if (!checkFunnelOrFail(run)) process.exit(1);

  const serveRes = run(["serve", "status", "--json"]);
  const serve = parseJsonOr(serveRes.stdout, null);
  const cls = classifyServe(serve);

  if (cls.mapsToLocal3000) {
    line("PASS", `Tailscale Serve already proxies HTTPS -> ${LOCAL_WEB}`);
  } else if (cls.conflict) {
    line("FAIL", "Tailscale Serve has a conflicting mapping; refusing to overwrite it.");
    line("INFO", "Remediation: review with `tailscale serve status`, then run:");
    line("INFO", "  tailscale serve reset && tailscale serve --bg http://127.0.0.1:3000");
    process.exit(1);
  } else {
    const add = run(["serve", "--bg", LOCAL_WEB]);
    if (!add.ok) {
      line("FAIL", `Failed to enable Tailscale Serve: ${(add.stderr || "").trim() || "unknown error"}`);
      process.exit(1);
    }
    line("PASS", `Tailscale Serve now proxies HTTPS -> ${LOCAL_WEB}`);
  }

  // Optional health probe (a stopped web server is a warning, not a mutation).
  const probe = await fetchWithTimeout(`${origin.origin}${HEALTH_PATH}`);
  if (probe.ok) {
    line("PASS", `Health check OK at ${origin.origin}${HEALTH_PATH}`);
  } else {
    line("WARN", `Could not reach ${origin.origin}${HEALTH_PATH} (${probe.error || probe.status || "no response"}).`);
    line("WARN", "Keep the web app running at http://localhost:3000 (pnpm --filter @rfid/web dev).");
  }

  // Origin discovered + Funnel off + Serve configured: persist the Field API
  // origin as the field app's Expo env default. Upserts ONLY this key,
  // preserving comments and other values; never prints file contents.
  upsertFieldEnvOrigin(origin.origin);
  line("PASS", `Wrote ${FIELD_ENV_KEY} to apps/field/.env.local.`);
  line("INFO", "Restart Metro to load the updated Expo env.");

  process.stdout.write("\n");
  line("INFO", `Field API URL:  ${origin.origin}`);
  line("INFO", "Keep the web app running at http://localhost:3000.");
  line("INFO", "In the Field app: Settings -> Web server URL -> paste the URL above -> Test connection.");
}

// ---------------------------------------------------------------------------
// DOCTOR (read-only)
// ---------------------------------------------------------------------------
async function doctor() {
  let hardFail = 0;

  const { run, source } = resolveOrFail();
  line("PASS", `tailscale CLI found (${sourceLabel(source)}).`);

  const statusRes = run(["status", "--json"]);
  const status = parseJsonOr(statusRes.stdout, null);
  const origin = discoverFieldOrigin(status);
  if (!origin.ok) {
    line("FAIL", `Tailscale not ready: ${origin.reason}`);
    line("INFO", "Remediation: `tailscale up` to sign in, then re-run `pnpm tailscale:doctor`.");
    hardFail = 1;
  } else {
    line("PASS", `Signed in; Field API URL: ${origin.origin}`);
  }

  const serveRes = run(["serve", "status", "--json"]);
  const serve = parseJsonOr(serveRes.stdout, null);
  const cls = classifyServe(serve);
  if (cls.mapsToLocal3000) {
    line("PASS", `Serve maps HTTPS -> ${LOCAL_WEB}`);
  } else if (cls.conflict) {
    line("FAIL", "Serve has a conflicting mapping (not localhost:3000 over HTTPS).");
    line("INFO", "Remediation: `tailscale serve status`, then `tailscale serve reset && tailscale serve --bg http://127.0.0.1:3000`");
    hardFail = 1;
  } else {
    line("WARN", "Serve is not configured for localhost:3000.");
    line("INFO", "Remediation: `pnpm tailscale:setup`");
  }

  // Funnel ON or unknown is a security/setup failure -> FAIL (never auto-disable).
  const funnelRes = run(["funnel", "status", "--json"]);
  const fun = classifyFunnel(parseJsonOr(funnelRes.stdout, null), funnelRes.ok);
  if (fun.state === "on") {
    line("FAIL", "Funnel is ON. Plan 011 uses the private tailnet only.");
    line("INFO", "Remediation: `tailscale funnel off`");
    hardFail = 1;
  } else if (fun.state === "unknown") {
    line("FAIL", `Funnel state unknown: ${fun.reason}.`);
    line("INFO", "Remediation: ensure Tailscale is running; if Funnel is on run `tailscale funnel off`.");
    hardFail = 1;
  } else {
    line("PASS", "Funnel is off.");
  }

  const local = await fetchWithTimeout(`http://127.0.0.1:3000${HEALTH_PATH}`);
  if (local.ok) {
    line("PASS", "Local web health OK (http://127.0.0.1:3000).");
  } else {
    line("WARN", `Local web health unreachable (${local.error || local.status || "no response"}).`);
    line("INFO", "Remediation: start the web app: `pnpm --filter @rfid/web dev`");
  }

  if (origin.ok) {
    const remote = await fetchWithTimeout(`${origin.origin}${HEALTH_PATH}`);
    if (remote.ok) {
      line("PASS", `Tailnet health OK (${origin.origin}).`);
    } else {
      line("WARN", `Tailnet health unreachable (${remote.error || remote.status || "no response"}).`);
      line("INFO", "Remediation: confirm Serve is configured and the web app is running, then re-run doctor.");
    }

    // Field env default-origin key matches the discovered origin? WARN (never
    // FAIL) when missing/stale — running `pnpm tailscale:setup` fixes it, and a
    // not-yet-restarted Metro must not fail the doctor.
    const envOrigin = readFieldEnvOrigin();
    if (envOrigin === origin.origin) {
      line("PASS", `apps/field/.env.local ${FIELD_ENV_KEY} matches the discovered origin.`);
    } else {
      line("WARN", `apps/field/.env.local ${FIELD_ENV_KEY} is missing or stale.`);
      line("INFO", "Remediation: `pnpm tailscale:setup`, then restart Metro to load the updated Expo env.");
    }
  }

  process.exit(hardFail);
}

const cmd = process.argv[2];
if (cmd === "setup") {
  setup().catch((e) => { line("FAIL", `setup error: ${e?.message || e}`); process.exit(1); });
} else if (cmd === "doctor") {
  doctor().catch((e) => { line("FAIL", `doctor error: ${e?.message || e}`); process.exit(1); });
} else {
  process.stderr.write("usage: node scripts/tailscale/tailscale.mjs <setup|doctor>\n");
  process.exit(2);
}
